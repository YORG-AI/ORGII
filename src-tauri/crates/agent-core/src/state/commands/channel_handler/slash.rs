//! Slash command handling (`/help`, `/new`, `/status`, `/compact`) for
//! channel-bound chats.

use crate::bus::{InboundMessage, OutboundMessage};
use crate::definitions::OS_AGENT_ID;
use crate::gateway::{GatewayCommand, SessionKey};
use crate::integrations::gateway::browse::{self, BrowseLevel, BrowseOption, BrowseState};
use crate::session::session_id::{next_version_for, os_session_id_base, with_version};
use crate::state::AgentAppState;
use crate::tools::impls::orchestration::channel::REINJECT_CHANNEL;
use core_types::key_source::KeySource;
use rusqlite::OptionalExtension;
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
        GatewayCommand::JourneyInvalid(message) => message,
        GatewayCommand::Journey(command) => match state.gateway_bindings.get(session_key).await {
            None => "当前聊天尚未绑定会话，无法执行 Journey 命令。".to_string(),
            Some(binding) => {
                let session_id = binding.target_session_id;
                match tokio::task::spawn_blocking(move || {
                    let provenance = if matches!(
                        command,
                        crate::core::journey_lifecycle::JourneyCommand::ForkClose { .. }
                    ) {
                        let record = crate::session::persistence::get_session(&session_id)
                            .map_err(|error| error.to_string())?
                            .ok_or_else(|| "未找到当前绑定会话，无法解析审核路由。".to_string())?;
                        let model_id = record.model.ok_or_else(|| {
                            "当前会话没有固定模型，禁止关闭分叉后 fallback。".to_string()
                        })?;
                        let account_id = record.account_id.ok_or_else(|| {
                            "当前会话没有固定账户，禁止关闭分叉后 fallback。".to_string()
                        })?;
                        let protocol = crate::providers::factory::resolve_account_protocol(
                            &model_id,
                            &account_id,
                        )
                        .map_err(|error| format!("无法解析当前会话协议：{error}"))?;
                        Some(crate::core::journey_lifecycle::RuntimeProvenance {
                            model_id,
                            account_id,
                            protocol,
                        })
                    } else {
                        None
                    };
                    database::db::with_sessions_writer(|| {
                        let mut conn =
                            database::db::get_connection().map_err(|error| error.to_string())?;
                        execute_bound_journey_command(&mut conn, &session_id, command, provenance)
                    })
                })
                .await
                {
                    Ok(Ok(reply)) => reply,
                    Ok(Err(error)) => format!("会话旅程操作未完成：{error}"),
                    Err(error) => format!("会话旅程操作未完成：{error}"),
                }
            }
        },
        GatewayCommand::NewSession => {
            state.gateway_bindings.clear(session_key).await;
            info!("[gateway] Cleared binding for {}", session_key.as_str());
            "Conversation reset. The next message starts a fresh session.".to_string()
        }
        GatewayCommand::SessionCurrent => build_session_current(state, session_key).await,
        GatewayCommand::SessionList => build_session_list(state, session_key).await,
        GatewayCommand::SessionTree => start_browse_tree(session_key).await,
        GatewayCommand::SessionRecent => start_browse_recent(session_key).await,
        GatewayCommand::BrowseNext => move_browse_page(session_key, true).await,
        GatewayCommand::BrowsePrev => move_browse_page(session_key, false).await,
        GatewayCommand::BrowseBack => browse_back(session_key).await,
        GatewayCommand::SessionSwitch(target) => switch_session(state, session_key, &target).await,
        GatewayCommand::SessionNew => {
            create_and_switch_session(state, msg, session_key, None).await
        }
        GatewayCommand::SessionNewNamed(name) => {
            create_and_switch_session(state, msg, session_key, name).await
        }
        GatewayCommand::NewSessionWithPrompt { name, prompt } => {
            create_switch_and_maybe_prompt(state, msg, session_key, name, prompt).await
        }
        GatewayCommand::SessionSearch(query) => search_session_context(&query).await,
        GatewayCommand::SessionBind { target, value } => {
            bind_active_context(state, session_key, &target, &value).await
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
                    format!(
                        "🗜️ Context compacted.\nCompressed: {} → {} messages (~{} → ~{} tokens).\nContinuing in new session `{}` (previous: `{}`).",
                        s.messages_before,
                        s.messages_after,
                        s.tokens_before,
                        s.tokens_after,
                        s.new_session_id,
                        s.old_session_id,
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

/// Execute a parsed Journey command at the gateway boundary. This is kept
/// separate from binding lookup and outbound delivery so every channel uses
/// the same provider-free lifecycle path.
fn execute_bound_journey_command(
    conn: &mut rusqlite::Connection,
    session_id: &str,
    command: crate::core::journey_lifecycle::JourneyCommand,
    provenance: Option<crate::core::journey_lifecycle::RuntimeProvenance>,
) -> Result<String, String> {
    crate::core::journey_lifecycle::JourneyApplicationService::execute_with_provenance(
        conn, session_id, None, command, provenance,
    )
}
pub(super) async fn handle_browse_selection(
    state: &AgentAppState,
    session_key: &SessionKey,
    number: usize,
) -> String {
    let loaded = tokio::task::spawn_blocking({
        let key = session_key.clone();
        move || browse::load(&key).map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string());
    let Ok(Ok(Some(snapshot))) = loaded else {
        return "浏览状态不可用，请使用 `/session tree` 重新开始。".to_string();
    };
    let Some(selected) = browse::selection(&snapshot, number) else {
        return format!(
            "请选择当前页面显示的编号（1-{}）。",
            browse::page_slice(&snapshot).len()
        );
    };

    match selected {
        BrowseOption::Project {
            workspace_id,
            project_slug,
            ..
        } => start_browse_sessions(session_key, workspace_id, project_slug).await,
        BrowseOption::Session {
            session_id,
            terminal_turn_id,
            terminal_turn_status,
        } => {
            bind_browse_leaf(
                state,
                session_key,
                &snapshot,
                &session_id,
                &terminal_turn_id,
                &terminal_turn_status,
            )
            .await
        }
    }
}

async fn clear_browse_state(session_key: &SessionKey) -> Result<(), String> {
    let key = session_key.clone();
    tokio::task::spawn_blocking(move || browse::clear(&key).map_err(|err| err.to_string()))
        .await
        .map_err(|err| err.to_string())?
}

async fn start_browse_tree(session_key: &SessionKey) -> String {
    start_browse_projects(session_key, None).await
}

async fn start_browse_projects(session_key: &SessionKey, workspace_id: Option<String>) -> String {
    let key = session_key.clone();
    let result = tokio::task::spawn_blocking(move || {
        let projects = project_management::projects::io::read_all_projects()?;
        let mut options: Vec<_> = projects
            .into_iter()
            .filter(|project| {
                workspace_id
                    .as_ref()
                    .map(|scope| project.meta.workspace_id.as_ref() == Some(scope))
                    .unwrap_or(true)
            })
            .map(|project| BrowseOption::Project {
                workspace_id: project.meta.workspace_id,
                project_slug: project.slug,
                name: project.meta.name,
            })
            .collect();
        options.sort_by(|a, b| browse_option_label(a).cmp(&browse_option_label(b)));
        let state = browse::new_state(
            &key,
            BrowseLevel::Project,
            workspace_id.clone(),
            None,
            options,
        );
        browse::save(&state).map_err(|err| err.to_string())?;
        let heading = workspace_id
            .as_deref()
            .map(|scope| format!("工作区 {scope} 的项目"))
            .unwrap_or_else(|| "项目".to_string());
        Ok::<_, String>(render_browse(&state, &heading))
    })
    .await;
    result
        .unwrap_or_else(|err| Err(err.to_string()))
        .unwrap_or_else(|err| format!("无法加载项目：{err}"))
}

async fn start_browse_sessions(
    session_key: &SessionKey,
    workspace_id: Option<String>,
    project_slug: String,
) -> String {
    let key = session_key.clone();
    let result = tokio::task::spawn_blocking(move || {
        let options = terminal_session_options(Some(&project_slug))?;
        let state = browse::new_state(
            &key,
            BrowseLevel::Session,
            workspace_id,
            Some(project_slug.clone()),
            options,
        );
        browse::save(&state).map_err(|err| err.to_string())?;
        Ok::<_, String>(render_browse(
            &state,
            &format!("项目 {project_slug} 的已结束会话"),
        ))
    })
    .await;
    result
        .unwrap_or_else(|err| Err(err.to_string()))
        .unwrap_or_else(|err| format!("无法加载会话：{err}"))
}

async fn start_browse_recent(session_key: &SessionKey) -> String {
    let key = session_key.clone();
    let result = tokio::task::spawn_blocking(move || {
        let options = terminal_session_options(None)?;
        let state = browse::new_state(&key, BrowseLevel::Session, None, None, options);
        browse::save(&state).map_err(|err| err.to_string())?;
        Ok::<_, String>(render_browse(&state, "最近已结束会话"))
    })
    .await;
    result
        .unwrap_or_else(|err| Err(err.to_string()))
        .unwrap_or_else(|err| format!("无法加载最近会话：{err}"))
}

async fn move_browse_page(session_key: &SessionKey, forward: bool) -> String {
    let key = session_key.clone();
    let result = tokio::task::spawn_blocking(move || {
        let Some(mut state) = browse::load(&key).map_err(|err| err.to_string())? else {
            return Ok::<_, String>(
                "当前没有项目树浏览状态，请使用 `/session tree` 重新开始。".to_string(),
            );
        };
        let page = if forward {
            state.page.saturating_add(1)
        } else {
            state.page.saturating_sub(1)
        };
        browse::set_page(&mut state, page);
        browse::save(&state).map_err(|err| err.to_string())?;
        Ok(render_browse(&state, browse_heading(&state)))
    })
    .await;
    result
        .unwrap_or_else(|err| Err(err.to_string()))
        .unwrap_or_else(|err| format!("无法切换浏览页：{err}"))
}

async fn browse_back(session_key: &SessionKey) -> String {
    let key = session_key.clone();
    let state = tokio::task::spawn_blocking(move || browse::load(&key)).await;
    let Ok(Ok(Some(state))) = state else {
        return "当前没有项目树浏览状态，请使用 `/session tree` 重新开始。".to_string();
    };
    match state.level {
        BrowseLevel::Project => start_browse_tree(session_key).await,
        BrowseLevel::Session => match state.project_slug {
            Some(_) => start_browse_projects(session_key, state.workspace_id).await,
            None => start_browse_tree(session_key).await,
        },
    }
}

async fn bind_browse_leaf(
    state: &AgentAppState,
    session_key: &SessionKey,
    snapshot: &BrowseState,
    session_id: &str,
    terminal_turn_id: &str,
    terminal_turn_status: &str,
) -> String {
    let session_id = session_id.to_string();
    let session_id_for_validation = session_id.clone();
    let expected_project = snapshot.project_slug.clone();
    let expected_turn_id = terminal_turn_id.to_string();
    let expected_status = terminal_turn_status.to_string();
    let checked = tokio::task::spawn_blocking(move || {
        let Some(record) = crate::session::persistence::get_session(&session_id_for_validation)
            .map_err(|err| err.to_string())?
        else {
            return Ok::<_, String>(false);
        };
        if expected_project.is_some() && record.project_slug != expected_project {
            return Ok(false);
        }
        let conn = database::db::get_connection().map_err(|err| err.to_string())?;
        let marker = conn
            .query_row(
                "SELECT last_terminal_turn_id, last_terminal_turn_status
                 FROM agent_sessions WHERE session_id = ?1",
                [&session_id_for_validation],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()
            .map_err(|err| err.to_string())?;
        Ok(marker == Some((Some(expected_turn_id), Some(expected_status))))
    })
    .await;
    match checked {
        Ok(Ok(true)) => {
            state
                .gateway_bindings
                .set(session_key.clone(), session_id.clone())
                .await;
            format!("已将当前聊天绑定到会话 `{session_id}`。最近已结束回合：`{terminal_turn_id}`（{}）。", terminal_turn_status_label(&terminal_turn_status))
        }
        Ok(Ok(false)) => {
            "该会话已不属于当前浏览快照，请使用 `/session tree` 或 `/session recent` 刷新。"
                .to_string()
        }
        Ok(Err(err)) => format!("无法校验会话：{err}"),
        Err(err) => format!("无法校验会话：{err}"),
    }
}

fn terminal_session_options(project_slug: Option<&str>) -> Result<Vec<BrowseOption>, String> {
    let conn = database::db::get_connection().map_err(|err| err.to_string())?;
    let mut sql = String::from(
        "SELECT session_id, last_terminal_turn_id, last_terminal_turn_status
         FROM agent_sessions
         WHERE last_terminal_turn_id IS NOT NULL
           AND last_terminal_turn_status IN ('completed', 'cancelled', 'failed')",
    );
    if project_slug.is_some() {
        sql.push_str(" AND project_slug = ?1");
    }
    sql.push_str(" ORDER BY last_terminal_turn_at DESC, updated_at DESC LIMIT 64");
    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let mut rows = if let Some(project_slug) = project_slug {
        stmt.query(rusqlite::params![project_slug])
    } else {
        stmt.query([])
    }
    .map_err(|err| err.to_string())?;
    let mut options = Vec::new();
    while let Some(row) = rows.next().map_err(|err| err.to_string())? {
        options.push(BrowseOption::Session {
            session_id: row.get(0).map_err(|err| err.to_string())?,
            terminal_turn_id: row.get(1).map_err(|err| err.to_string())?,
            terminal_turn_status: row.get(2).map_err(|err| err.to_string())?,
        });
    }
    Ok(options)
}

fn render_browse(state: &BrowseState, heading: &str) -> String {
    let mut lines = vec![format!("**{heading}**")];
    let page = browse::page_slice(state);
    if page.is_empty() {
        lines.push("此层级暂无可选项。".to_string());
    } else {
        for (index, option) in page.iter().enumerate() {
            lines.push(format!("{}. {}", index + 1, browse_option_label(option)));
        }
    }
    lines.push(format!(
        "第 {}/{} 页 · `/next` `/prev` · `/0` 返回",
        state.page + 1,
        browse::page_count(state)
    ));
    lines.join("\n")
}

fn browse_heading(state: &BrowseState) -> &str {
    match state.level {
        BrowseLevel::Project => "项目",
        BrowseLevel::Session => "已结束会话",
    }
}

fn browse_option_label(option: &BrowseOption) -> String {
    match option {
        BrowseOption::Project {
            workspace_id,
            project_slug,
            name,
        } => workspace_id
            .as_deref()
            .map(|workspace| format!("{project_slug} · {name}（工作区：{workspace}）"))
            .unwrap_or_else(|| format!("{project_slug} · {name}")),
        BrowseOption::Session {
            session_id,
            terminal_turn_id,
            terminal_turn_status,
        } => {
            format!(
                "{session_id} · 结束回合 `{terminal_turn_id}`（{}）",
                terminal_turn_status_label(terminal_turn_status)
            )
        }
    }
}

fn terminal_turn_status_label(status: &str) -> &str {
    match status {
        "completed" => "已完成",
        "cancelled" => "已取消",
        "failed" => "失败",
        _ => "未知状态",
    }
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
    if !name.is_empty() && name != s.session_id {
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
    requested_name: Option<String>,
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
    let display_name = requested_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let persist_sid = sid.clone();
    let persist_channel = msg.channel.clone();
    let persist_chat_id = msg.chat_id.clone();
    let persist_name = display_name
        .clone()
        .unwrap_or_else(|| format!("Channel: {}", persist_channel));
    let _ = tokio::task::spawn_blocking(move || {
        let now = chrono::Utc::now().to_rfc3339();
        let record = crate::session::persistence::UnifiedSessionRecord {
            session_id: persist_sid,
            name: persist_name,
            status: crate::session::SessionStatus::Idle.as_str().to_string(),
            session_type: crate::session::persistence::session_type::DESKTOP.to_string(),
            channel: Some(persist_channel),
            chat_id: Some(persist_chat_id),
            created_at: now.clone(),
            updated_at: now,
            key_source: KeySource::OwnKey,
            ..Default::default()
        };
        crate::session::persistence::upsert_session(&record)
    })
    .await;
    state
        .gateway_bindings
        .set(session_key.clone(), sid.clone())
        .await;
    match display_name {
        Some(name) => format!(
            "Created and switched to fresh channel session `{}` named `{}`.\nRecent context is empty; continue with the new topic.",
            sid, name
        ),
        None => format!(
            "Created and switched to fresh channel session `{}`.\nRecent context is empty; continue with the new topic.",
            sid
        ),
    }
}
async fn create_switch_and_maybe_prompt(
    state: &AgentAppState,
    msg: &InboundMessage,
    session_key: &SessionKey,
    name: String,
    prompt: Option<String>,
) -> String {
    let created = create_and_switch_session(state, msg, session_key, Some(name.clone())).await;
    let Some(prompt_text) = prompt
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
    else {
        return created;
    };
    let Some(binding) = state.gateway_bindings.get(session_key).await else {
        return format!(
            "{}

Created, but could not dispatch prompt: no active binding found.",
            created
        );
    };
    let target_sid = binding.target_session_id;
    let sender_placeholder = if msg.sender_id.is_empty() {
        OS_AGENT_ID
    } else {
        msg.sender_id.as_str()
    };
    let mut inbound = InboundMessage::new(
        REINJECT_CHANNEL,
        sender_placeholder,
        &target_sid,
        &prompt_text,
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
    inbound.media = msg.media.clone();
    let send_result = {
        let bus = state.bus.lock().await;
        bus.inbound_sender().send(inbound).await
    };
    match send_result {
        Ok(()) => format!(
            "{}

Initial prompt dispatched to `{}`.",
            created, target_sid
        ),
        Err(err) => format!(
            "{}

Created, but failed to dispatch prompt: {}",
            created, err
        ),
    }
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
async fn handle_model_command(
    state: &AgentAppState,
    _msg: &InboundMessage,
    session_key: &SessionKey,
    requested: Option<&str>,
) -> String {
    let Some(binding) = state.gateway_bindings.get(session_key).await else {
        return "还没有绑定会话。先发一条普通消息创建当前 Feishu 会话后，再用 `/model <模型>` 切换。"
            .to_string();
    };
    let Some(requested) = requested.map(str::trim).filter(|s| !s.is_empty()) else {
        return format!(
            "用法：`/model <模型>`。常用别名：gpt-5.5、gpt5.5、fable、sonnet、opus。当前会话：`{}`",
            binding.target_session_id
        );
    };
    let account_id = state.current_account_id.lock().await.clone().or_else(|| {
        state
            .integrations
            .snapshot()
            .channels
            .gateway
            .account_id
            .clone()
    });
    let Some((model, account_id)) = resolve_model_target(requested, account_id.as_deref()) else {
        return format!("未找到模型 `{}`", requested);
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
            // # 模型切换后必须丢弃旧 runtime；下一轮会用持久化后的 model 重建 provider。
            state.invalidate_session(&binding.target_session_id).await;
            let note = format!("已切换到 {}", model);
            let sid_for_note = binding.target_session_id.clone();
            let note_for_db = note.clone();
            let _ = tokio::task::spawn_blocking(move || {
                crate::session::persistence::save_compact_summary_msg(&sid_for_note, &note_for_db)
            })
            .await;
            note
        }

        Ok(Ok(false)) => format!("切换模型失败：会话 {} 不存在", binding.target_session_id),
        Ok(Err(err)) => format!("切换模型失败：{}", err),
        Err(err) => format!("切换模型失败：{}", err),
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
            // 优先使用 KeyVault 当前账号真实可用的 model id。model_aliases.alias 在
            // ORG2 里也是可调用 model id，不是 `/model fable` 这种用户输入别名。
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
                best_candidate_for_alias(&candidates, target)
                    .unwrap_or_else(|| (*target).to_string()),
                account_id.map(str::to_string),
            ));
        }
    }
    candidates
        .iter()
        .find(|m| normalize_model_key(m) == needle)
        .or_else(|| {
            candidates
                .iter()
                .find(|m| normalize_model_key(m).contains(&needle))
        })
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
    // 带 provider / route 的完整 id 优先；避免再次把 `claude-fable-5` 写回库。
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

/// Static cheat-sheet for the `/help` slash command.
fn build_help_text() -> String {
    [
        "**ORG2 commands** (gateway; no LLM tokens)",
        "**General**",
        "`/help` (`/commands`) · `/status` · `/new` (`/reset`)",
        "`/model <model>` · `/compact`",
        "**Sessions**",
        "`/session current` (`/ctx current`)",
        "`/session list` (`/session ls`, `/ctx ls`)",
        "`/session switch <id>` (`/session use <id>`)",
        "`/session new [name]` · `/newsession <name> [prompt]`",
        "`/session search <query>`",
        "**Journey**",
        "`/journey` · `/task start <name> [recent|next]`",
        "`/task checkpoint <name> <exact-message-id>`",
        "`/task finish <outcome>`",
        "`/fork start <name> <exact-anchor>` · `/fork close <outcome>` · `/fork compare`",
        "`/review list` · `/review discard <id>` · `/review confirm ...`",
        "**Project context**",
        "`/session bind project <slug>`",
        "`/session bind workitem <project>:<id>` · `manage_work_item` (`wi`)",
    ]
    .join("\n")
}

#[cfg(test)]
mod help_text_tests {
    use super::{
        best_candidate_for_alias, build_help_text, normalize_model_key, resolve_model_target,
    };

    #[test]
    fn lists_every_supported_slash_command() {
        let text = build_help_text();
        for cmd in [
            "/help",
            "/new",
            "/status",
            "/compact",
            "/model",
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
    fn model_aliases_resolve_without_key_vault() {
        assert_eq!(normalize_model_key("gpt-5.5"), "gpt55");
        assert_eq!(
            resolve_model_target("gpt-5.5", None).unwrap().0,
            "openai/gpt-5.5:openai"
        );
        assert_eq!(
            resolve_model_target("gpt5.5", None).unwrap().0,
            "openai/gpt-5.5:openai"
        );
        assert_eq!(
            resolve_model_target("sonnet", None).unwrap().0,
            "anthropic/claude-sonnet-4-6:anthropic"
        );
        assert_eq!(
            resolve_model_target("opus", None).unwrap().0,
            "anthropic/claude-opus-4-6:anthropic"
        );
        assert_eq!(
            resolve_model_target("fable", None).unwrap().0,
            "anthropic/claude-fable-5:anthropic"
        );
    }

    #[test]
    fn alias_candidate_prefers_full_model_ids() {
        let candidates = vec![
            "claude-fable-5".to_string(),
            "anthropic/anthropic/claude-fable-5:anthropic".to_string(),
        ];
        assert_eq!(
            best_candidate_for_alias(&candidates, "anthropic/claude-fable-5:anthropic").unwrap(),
            "anthropic/anthropic/claude-fable-5:anthropic"
        );
    }

    #[test]
    fn fits_message_budget() {
        assert!(build_help_text().len() < 4096);
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
    fn fits_telegram_message_budget() {
        // Hermes caps at 4096 (Telegram limit). 1KB is plenty of head-room
        // for a static list and forces us to revisit if we balloon.
        assert!(build_help_text().len() < 1024);
    }
}

#[cfg(test)]
mod journey_dispatch_tests {
    use super::execute_bound_journey_command;
    use crate::core::session::journey_application_service::{
        CreateTaskRequest, JourneyApplicationError, SessionJourneyApplicationService,
        TaskStartPosition,
    };
    use crate::gateway::{parse_command, GatewayCommand};

    #[test]
    fn feishu_journey_inbound_dispatch_uses_no_provider_and_shares_durable_cas() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE agent_sessions (session_id TEXT PRIMARY KEY);
             CREATE TABLE agent_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                role TEXT NOT NULL DEFAULT 'user'
             );
             INSERT INTO agent_sessions (session_id) VALUES ('feishu:chat-1:user-1');
             INSERT INTO agent_messages (id, session_id, sequence, role)
             VALUES ('message-1', 'feishu:chat-1:user-1', 1, 'user');",
        )
        .unwrap();

        let GatewayCommand::Journey(command) = parse_command("/task start 飞书核对 recent")
            .expect("Feishu inbound text must parse as a Journey command")
        else {
            panic!("Journey control input must not be routed to a provider");
        };
        let reply = execute_bound_journey_command(&mut conn, "feishu:chat-1:user-1", command, None)
            .expect("Journey dispatch must complete without a configured provider");
        assert!(reply.contains("最近一条用户消息"));

        let error = SessionJourneyApplicationService::create_task(
            &mut conn,
            CreateTaskRequest {
                session_id: "feishu:chat-1:user-1".into(),
                expected_revision: 0,
                task_id: "desktop-stale".into(),
                name: "桌面旧修订".into(),
                position: TaskStartPosition::下一条用户消息,
            },
        )
        .expect_err("desktop must observe the revision written by the Feishu adapter");
        assert!(matches!(
            error,
            JourneyApplicationError::修订冲突 {
                expected: 0,
                actual: 1
            }
        ));
    }
}
