//! Slash command handling (`/help`, `/new`, `/status`, `/model`, `/compact`) for
//! channel-bound chats.

use crate::bus::{InboundMessage, OutboundMessage};
use crate::gateway::{GatewayCommand, SessionKey};
use crate::session::session_id::{next_version_for, os_session_id_base, with_version};
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
        GatewayCommand::SessionCurrent => build_session_current(state, session_key).await,
        GatewayCommand::SessionList => build_session_list(state, session_key).await,
        GatewayCommand::SessionSwitch(target) => switch_session(state, session_key, &target).await,
        GatewayCommand::SessionNew => create_and_switch_session(state, msg, session_key).await,
        GatewayCommand::SessionSearch(query) => search_session_context(&query).await,
        GatewayCommand::SessionBind { target, value } => {
            bind_active_context(state, session_key, &target, &value).await
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
            // Model switch must drop the old runtime; next turn rebuilds from persistence.
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
        Ok(Ok(false)) => format!(
            "Model switch failed: session {} does not exist",
            binding.target_session_id
        ),
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
            // Prefer real callable ids from the active KeyVault account.
            candidates.extend(key.enabled_models.iter().cloned());
            candidates.extend(key.available_models.iter().cloned());
            candidates.extend(key.model_aliases.iter().map(|alias| alias.alias.clone()));
        }
    }
    candidates.extend(DEFAULT_MODEL_TARGETS.iter().copied().map(str::to_string));
    candidates.sort();
    candidates.dedup();

    for (target, names) in MODEL_INPUT_ALIASES {
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

const DEFAULT_MODEL_TARGETS: &[&str] = &[
    "openai/gpt-5.5:openai",
    "anthropic/claude-fable-5:anthropic",
    "anthropic/claude-sonnet-4-6:anthropic",
    "anthropic/claude-opus-4-6:anthropic",
];

const MODEL_INPUT_ALIASES: &[(&str, &[&str])] = &[
    ("openai/gpt-5.5:openai", &["gpt-5.5", "gpt5.5", "gpt55"]),
    ("anthropic/claude-fable-5:anthropic", &["fable"]),
    ("anthropic/claude-sonnet-4-6:anthropic", &["sonnet"]),
    ("anthropic/claude-opus-4-6:anthropic", &["opus"]),
];

fn best_candidate_for_alias(candidates: &[String], canonical_target: &str) -> Option<String> {
    let target_norm = normalize_model_key(canonical_target);
    let target_base_norm = normalize_model_key(strip_model_route(canonical_target));
    let mut matches: Vec<&String> = candidates
        .iter()
        .filter(|m| {
            let norm = normalize_model_key(m);
            norm == target_norm
                || norm == target_base_norm
                || norm.ends_with(&target_base_norm)
                || norm.contains(&target_base_norm)
        })
        .collect();
    // Prefer full provider/route ids; avoid writing bare aliases like `claude-fable-5`.
    matches.sort_by_key(|m| candidate_rank(m, canonical_target));
    matches.first().map(|m| (*m).clone())
}

fn candidate_rank(model: &str, canonical_target: &str) -> (u8, usize) {
    let norm = normalize_model_key(model);
    let canonical_norm = normalize_model_key(canonical_target);
    let has_route = model.contains('/') || model.contains(':');
    (
        if norm == canonical_norm {
            0
        } else if has_route {
            1
        } else {
            2
        },
        model.len(),
    )
}

fn strip_model_route(model: &str) -> &str {
    let without_route = model.split(':').next().unwrap_or(model);
    without_route.rsplit('/').next().unwrap_or(without_route)
}

fn normalize_model_key(value: &str) -> String {
    value
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

async fn build_session_current(state: &AgentAppState, session_key: &SessionKey) -> String {
    match state.gateway_bindings.get(session_key).await {
        Some(binding) => {
            let meta = session_meta_line(&binding.target_session_id);
            format!(
                "**Current channel session**\n• Binding: `{}` → `{}`\n{}",
                session_key.as_str(),
                binding.target_session_id,
                meta
            )
        }
        None => "**Current channel session**\n• No active session yet (send a message or use `/session new`).".to_string(),
    }
}

async fn build_session_list(state: &AgentAppState, session_key: &SessionKey) -> String {
    let sessions = tokio::task::spawn_blocking(|| {
        let filter = crate::session::SessionListFilter {
            limit: Some(12),
            ..Default::default()
        };
        crate::session::persistence::list_sessions(&filter).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())
    .and_then(|x| x);

    let Ok(sessions) = sessions else {
        return "无法读取会话列表。".to_string();
    };
    if sessions.is_empty() {
        return "还没有可切换的 ORG2 会话。".to_string();
    }

    let current = state
        .gateway_bindings
        .get(session_key)
        .await
        .map(|b| b.target_session_id);
    let mut blocks = vec!["**可切换会话**".to_string()];
    for (idx, s) in sessions.into_iter().enumerate() {
        let current_badge = if current.as_deref() == Some(s.session_id.as_str()) {
            " · ✅ 当前"
        } else {
            ""
        };
        let recent = recent_session_preview(&s.session_id);
        blocks.push(format!(
            "**#{:02} · {}{}**\n{}\n`{}`\n{}\n{}",
            idx + 1,
            human_session_title(&s),
            current_badge,
            human_session_context(&s),
            s.session_id,
            human_session_relation(&s, &recent),
            recent,
        ));
    }
    blocks.push(
        "**操作**\n切换：`/session switch <session_id>`\n新建：`/session new`\n搜索：`/session search <关键词>`"
            .to_string(),
    );
    blocks.join("\n\n")
}

fn human_session_title(s: &crate::session::persistence::UnifiedSessionRecord) -> String {
    if let Some(item) = s.work_item_id.as_deref().filter(|x| !x.trim().is_empty()) {
        return format!("任务 {}", item);
    }
    if let Some(project) = s.project_slug.as_deref().filter(|x| !x.trim().is_empty()) {
        return format!("项目 {}", project);
    }
    let name = s.name.trim();
    if !name.is_empty() && name != s.session_id && !name.starts_with("Channel:") {
        return crate::utils::safe_truncate_chars_to_string(name, 48);
    }
    if let Some(title) = recent_user_title(&s.session_id) {
        return title;
    }
    if let Some(channel) = s.channel.as_deref().filter(|x| !x.trim().is_empty()) {
        return format!("{} 讨论", compact_channel_name(channel));
    }
    "未命名会话".to_string()
}

fn compact_channel_name(channel: &str) -> String {
    channel.split(':').next().unwrap_or(channel).to_string()
}

fn human_session_context(s: &crate::session::persistence::UnifiedSessionRecord) -> String {
    let mut parts = Vec::new();
    if let Some(channel) = s.channel.as_deref().filter(|x| !x.trim().is_empty()) {
        parts.push(format!("来源：{}", compact_channel_name(channel)));
    }
    if let Some(workspace) = s.workspace_path.as_deref().filter(|x| !x.trim().is_empty()) {
        parts.push(format!(
            "工作区：{}",
            crate::utils::safe_truncate_chars_to_string(workspace, 36)
        ));
    }
    parts.push(format!("更新：{}", human_time_hint(&s.updated_at)));
    parts.join(" · ")
}

fn human_session_relation(
    s: &crate::session::persistence::UnifiedSessionRecord,
    recent: &str,
) -> String {
    let mut parts = Vec::new();
    if let Some(project) = s.project_slug.as_deref().filter(|x| !x.trim().is_empty()) {
        parts.push(format!("项目 `{}`", project));
    }
    if let Some(item) = s.work_item_id.as_deref().filter(|x| !x.trim().is_empty()) {
        parts.push(format!("任务 `{}`", item));
    }
    if parts.is_empty() {
        if recent.contains("WI-") || recent.contains("任务") {
            parts.push("可能关联任务（未绑定）".to_string());
        } else {
            parts.push("未绑定项目/任务".to_string());
        }
    }
    parts.join(" · ")
}

fn human_time_hint(ts: &str) -> String {
    ts.split('T')
        .nth(1)
        .and_then(|tail| tail.get(0..5))
        .map(|hhmm| hhmm.to_string())
        .unwrap_or_else(|| ts.to_string())
}

fn recent_user_title(session_id: &str) -> Option<String> {
    crate::session::persistence::load_messages(session_id)
        .ok()?
        .into_iter()
        .rev()
        .find(|row| row.role == "user" && !row.content.trim().is_empty())
        .map(|row| {
            let text = row.content.replace('\n', " ");
            crate::utils::safe_truncate_chars_to_string(text.trim(), 32)
        })
        .filter(|s| !s.trim().is_empty())
}

fn recent_session_preview(session_id: &str) -> String {
    match crate::session::persistence::load_messages(session_id) {
        Ok(rows) => rows
            .into_iter()
            .rev()
            .find_map(|row| {
                let text = row.content.replace('\n', " ");
                let text = text.trim();
                if text.is_empty() {
                    None
                } else {
                    Some(format!(
                        "最近：{}：{}",
                        role_label(&row.role),
                        crate::utils::safe_truncate_chars_to_string(text, 88)
                    ))
                }
            })
            .unwrap_or_else(|| "最近：暂无文本消息".to_string()),
        Err(_) => "最近：不可用".to_string(),
    }
}

fn role_label(role: &str) -> &str {
    match role {
        "user" => "用户",
        "assistant" => "助手",
        "system" => "系统",
        other => other,
    }
}

async fn switch_session(state: &AgentAppState, session_key: &SessionKey, target: &str) -> String {
    let sid = target.trim().to_string();
    let exists = tokio::task::spawn_blocking({
        let sid = sid.clone();
        move || crate::session::persistence::get_session(&sid).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())
    .and_then(|x| x);

    match exists {
        Ok(Some(record)) => {
            state
                .gateway_bindings
                .set_with_activity(session_key.clone(), sid.clone(), record.updated_at.clone())
                .await;
            format!(
                "Switched this chat to `{}`.\n{}\n\n{}",
                sid,
                session_meta_line(&sid),
                recent_session_summary(&sid, 6)
            )
        }
        Ok(None) => format!("Session not found: `{}`", sid),
        Err(err) => format!("Could not switch session: {}", err),
    }
}

async fn create_and_switch_session(
    state: &AgentAppState,
    msg: &InboundMessage,
    session_key: &SessionKey,
) -> String {
    let base = os_session_id_base(&msg.channel, &msg.chat_id);
    let sid = tokio::task::spawn_blocking(move || {
        next_version_for(&base)
            .map(|n| with_version(&base, n))
            .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())
    .and_then(|x| x);

    let Ok(sid) = sid else {
        return "Could not create a fresh channel session.".to_string();
    };
    super::dispatch::ensure_os_session_registered(state, &sid).await;
    state
        .gateway_bindings
        .set(session_key.clone(), sid.clone())
        .await;
    format!(
        "Created and switched to fresh channel session `{}`.\nRecent context is empty; continue with the new topic.",
        sid
    )
}

async fn search_session_context(query: &str) -> String {
    match crate::session::session_memory_search::search_session_memories(query, 5).await {
        Ok(hits) if hits.is_empty() => format!(
            "No indexed session-memory hits for `{}`. Session Memory indexes are created after SM extraction runs.",
            query
        ),
        Ok(hits) => {
            let mut lines = vec![format!("**Session Memory hits for:** `{}`", query)];
            for hit in hits {
                let preview = crate::utils::safe_truncate_chars_to_string(
                    &hit.content.replace('\n', " "),
                    220,
                );
                lines.push(format!(
                    "• `{}` score={:.3} updated={}
  {}",
                    hit.session_id, hit.score, hit.updated_at, preview
                ));
            }
            lines.push("Use `/session switch <session_id>` to bind this chat to one of these sessions.".to_string());
            lines.join("
")
        }
        Err(err) => format!("Session-memory search failed: {}", err),
    }
}

async fn bind_active_context(
    state: &AgentAppState,
    session_key: &SessionKey,
    target: &str,
    value: &str,
) -> String {
    let Some(binding) = state.gateway_bindings.get(session_key).await else {
        return "No active session yet. Send a message or use `/session new` first.".to_string();
    };
    let session_id = binding.target_session_id;
    match target {
        "project" => match update_session_project(&session_id, value).await {
            Ok(()) => format!("Bound current session `{}` to project `{}`.", session_id, value),
            Err(err) => format!("Could not bind project: {}", err),
        },
        "workitem" | "work_item" | "item" => match bind_session_work_item(&session_id, value).await {
            Ok((project_slug, short_id)) => format!(
                "Bound current session `{}` to work item `{}` in project `{}`.",
                session_id, short_id, project_slug
            ),
            Err(err) => format!("Could not bind work item: {}", err),
        },
        _ => "Unknown bind target. Use `/session bind project <slug>` or `/session bind workitem <id>`.".to_string(),
    }
}

async fn update_session_project(session_id: &str, project_slug: &str) -> Result<(), String> {
    let sid = session_id.to_string();
    let slug = project_slug.to_string();
    tokio::task::spawn_blocking(move || {
        let project = project_management::projects::io::read_project(&slug)?;
        let ok = crate::session::persistence::update_work_item_link(
            &sid,
            &project.meta.org_id,
            Some(&project.meta.id),
            Some(&project.meta.name),
            &slug,
            "",
            Some("orchestrator"),
        )
        .map_err(|err| err.to_string())?;
        if ok {
            Ok(())
        } else {
            Err(format!("Session not found: {sid}"))
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

async fn bind_session_work_item(session_id: &str, value: &str) -> Result<(String, String), String> {
    let sid = session_id.to_string();
    let raw = value.to_string();
    tokio::task::spawn_blocking(move || {
        let (project_slug, short_id) = resolve_work_item_ref(&raw)?;
        let project = project_management::projects::io::read_project(&project_slug)?;
        project_management::projects::io::read_work_item(&project_slug, &short_id)?;
        let ok = crate::session::persistence::update_work_item_link(
            &sid,
            &project.meta.org_id,
            Some(&project.meta.id),
            Some(&project.meta.name),
            &project_slug,
            &short_id,
            Some("orchestrator"),
        )
        .map_err(|err| err.to_string())?;
        if !ok {
            return Err(format!("Session not found: {sid}"));
        }
        Ok((project_slug, short_id))
    })
    .await
    .map_err(|err| err.to_string())?
}

fn resolve_work_item_ref(raw: &str) -> Result<(String, String), String> {
    if let Some((project_slug, short_id)) = raw.split_once(':') {
        return Ok((project_slug.to_string(), short_id.to_string()));
    }
    Err(format!(
        "Work item binding currently requires <project_slug>:<short_id> (got `{raw}`)"
    ))
}

fn session_meta_line(session_id: &str) -> String {
    match crate::session::persistence::get_session(session_id) {
        Ok(Some(s)) => format!(
            "• Name: {}{}",
            session_display_name(&s),
            session_project_suffix(s.project_slug.as_deref(), s.work_item_id.as_deref())
        ),
        _ => "• Metadata unavailable.".to_string(),
    }
}

fn session_display_name(s: &crate::session::persistence::UnifiedSessionRecord) -> String {
    if !s.name.trim().is_empty() {
        s.name.clone()
    } else {
        s.session_id.clone()
    }
}

fn session_project_suffix(project_slug: Option<&str>, work_item_id: Option<&str>) -> String {
    match (project_slug, work_item_id) {
        (Some(p), Some(w)) if !p.is_empty() && !w.is_empty() => {
            format!(" · project `{}` · item `{}`", p, w)
        }
        (Some(p), _) if !p.is_empty() => format!(" · project `{}`", p),
        _ => String::new(),
    }
}

fn recent_session_summary(session_id: &str, limit: usize) -> String {
    match crate::session::persistence::load_messages(session_id) {
        Ok(rows) => {
            let mut lines =
                vec!["Recent context (deterministic last-message summary):".to_string()];
            let selected: Vec<_> = rows.into_iter().rev().take(limit).collect();
            if selected.is_empty() {
                return "Recent context: (empty)".to_string();
            }
            for row in selected.into_iter().rev() {
                let role = row.role;
                let text = crate::utils::safe_truncate_chars_to_string(
                    &row.content.replace('\n', " "),
                    160,
                );
                if !text.trim().is_empty() {
                    lines.push(format!("- {}: {}", role, text));
                }
            }
            if lines.len() == 1 {
                "Recent context: (no text messages)".to_string()
            } else {
                lines.join("\n")
            }
        }
        Err(err) => format!("Recent context unavailable: {}", err),
    }

}

/// Static cheat-sheet for the `/help` slash command.
fn build_help_text() -> String {
    [
        "**ORG2 Channel Commands**",
        "These commands are handled inside the gateway before the OS agent runs, so they do **not** spend LLM tokens.",
        "",
        "**General**",
        "`/help` — show this list (alias: `/commands`).",
        "`/status` — show this chat's current binding and active runtime sessions.",
        "`/new` — clear this chat's binding; the next normal message creates a fresh session (alias: `/reset`).",
        "`/model <model>` — switch the bound channel session model. Common aliases: gpt-5.5, fable, sonnet, opus.",
        "`/compact` — manually compact the current channel session and continue in a versioned successor.",
        "",
        "**Session switching**",
        "`/session current` — show the active channel-bound ORG2 session (alias: `/ctx current`).",
        "`/session list` — list recent ORG2 sessions (aliases: `/session ls`, `/ctx ls`).",
        "`/session switch <session_id>` — bind this Feishu chat to an existing session and show recent context (alias: `/session use <session_id>`).",
        "`/session new` — create and bind a fresh session immediately.",
        "`/session search <query>` — semantic search across indexed Session Memory summaries (embedding + rerank).",
        "",
        "**Active project / Work Item context**",
        "`/session bind project <slug>` — set active project context for this channel session.",
        "`/session bind workitem <project_slug>:<short_id>` — set active Work Item context for this channel session.",
        "",
        "**Work Items via agent tools**",
        "Natural language requests can create/update/list Work Items with `manage_work_item` (`wi` alias).",
        "Project Work Items can be started with `manage_work_item(action=\"start\", project_slug=..., short_id=...)`.",
    ]
    .join("\n")
}

#[cfg(test)]
mod help_text_tests {
    use super::{best_candidate_for_alias, build_help_text, normalize_model_key};

    #[test]
    fn lists_every_supported_slash_command() {
        let text = build_help_text();
        for cmd in [
            "/help",
            "/new",
            "/status",
            "/model",
            "/compact",
            "/session current",
            "/session switch",
        ] {
            assert!(text.contains(cmd), "help cheat-sheet missing {cmd}: {text}");
        }
    }

    #[test]
    fn does_not_advertise_removed_agent_command() {
        let text = build_help_text();
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
        assert_eq!(
            normalize_model_key("openai/gpt-5.5:openai"),
            "openaigpt55openai"
        );
        assert_eq!(normalize_model_key("GPT-5.5"), "gpt55");
    }

    #[test]
    fn fits_message_budget() {
        assert!(build_help_text().len() < 4096);
    }
}
