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
        GatewayCommand::NewSession => {
            state.gateway_bindings.clear(session_key).await;
            if let Err(err) = clear_browse_state(session_key).await {
                return Err(format!("Could not clear project-tree navigation: {err}"));
            }
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

/// Handle an exact positive integer only after the dispatcher has confirmed
/// that this chat owns a durable browse snapshot. This never creates a turn.
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
        return "Browse state is unavailable; use `/session tree` to start again.".to_string();
    };
    let Some(selected) = browse::selection(&snapshot, number) else {
        return format!(
            "Choose a number shown on this page (1-{}).",
            browse::page_slice(&snapshot).len()
        );
    };

    match selected {
        BrowseOption::Workspace { workspace_id } => {
            start_browse_projects(session_key, workspace_id).await
        }
        BrowseOption::Project { project_slug, .. } => {
            start_browse_work_items(session_key, snapshot.workspace_id, project_slug).await
        }
        BrowseOption::WorkItem { work_item_id, .. } => {
            let Some(project_slug) = snapshot.project_slug else {
                return "Browse snapshot is missing its project scope; use `/session tree` again."
                    .to_string();
            };
            start_browse_sessions(
                session_key,
                snapshot.workspace_id,
                project_slug,
                work_item_id,
            )
            .await
        }
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
    let key = session_key.clone();
    let result = tokio::task::spawn_blocking(move || {
        let projects = project_management::projects::io::read_all_projects()?;
        let mut workspace_ids: Vec<Option<String>> = projects
            .into_iter()
            .map(|project| project.meta.workspace_id)
            .collect();
        workspace_ids.sort();
        workspace_ids.dedup();
        let options = workspace_ids
            .into_iter()
            .map(|workspace_id| BrowseOption::Workspace { workspace_id })
            .collect();
        let state = browse::new_state(&key, BrowseLevel::Workspace, None, None, None, options);
        browse::save(&state).map_err(|err| err.to_string())?;
        Ok::<_, String>(render_browse(&state, "Workspaces"))
    })
    .await;
    result
        .unwrap_or_else(|err| Err(err.to_string()))
        .unwrap_or_else(|err| format!("Could not load project tree: {err}"))
}

async fn start_browse_projects(session_key: &SessionKey, workspace_id: Option<String>) -> String {
    let key = session_key.clone();
    let result = tokio::task::spawn_blocking(move || {
        let projects = project_management::projects::io::read_all_projects()?;
        let mut options: Vec<_> = projects
            .into_iter()
            .filter(|project| project.meta.workspace_id == workspace_id)
            .map(|project| BrowseOption::Project {
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
            None,
            options,
        );
        browse::save(&state).map_err(|err| err.to_string())?;
        let heading = workspace_id.as_deref().unwrap_or("Unlinked workspace");
        Ok::<_, String>(render_browse(&state, &format!("Projects in {heading}")))
    })
    .await;
    result
        .unwrap_or_else(|err| Err(err.to_string()))
        .unwrap_or_else(|err| format!("Could not load projects: {err}"))
}

async fn start_browse_work_items(
    session_key: &SessionKey,
    workspace_id: Option<String>,
    project_slug: String,
) -> String {
    let key = session_key.clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut options: Vec<_> =
            project_management::projects::io::read_all_work_items(&project_slug)?
                .into_iter()
                .filter(|item| item.frontmatter.deleted_at.is_none())
                .map(|item| BrowseOption::WorkItem {
                    work_item_id: item.frontmatter.short_id,
                    title: item.frontmatter.title,
                })
                .collect();
        options.sort_by(|a, b| browse_option_label(a).cmp(&browse_option_label(b)));
        let state = browse::new_state(
            &key,
            BrowseLevel::WorkItem,
            workspace_id,
            Some(project_slug.clone()),
            None,
            options,
        );
        browse::save(&state).map_err(|err| err.to_string())?;
        Ok::<_, String>(render_browse(
            &state,
            &format!("Work Items in {project_slug}"),
        ))
    })
    .await;
    result
        .unwrap_or_else(|err| Err(err.to_string()))
        .unwrap_or_else(|err| format!("Could not load work items: {err}"))
}

async fn start_browse_sessions(
    session_key: &SessionKey,
    workspace_id: Option<String>,
    project_slug: String,
    work_item_id: String,
) -> String {
    let key = session_key.clone();
    let result = tokio::task::spawn_blocking(move || {
        let options = terminal_session_options(Some(&project_slug), Some(&work_item_id))?;
        let state = browse::new_state(
            &key,
            BrowseLevel::Session,
            workspace_id,
            Some(project_slug.clone()),
            Some(work_item_id.clone()),
            options,
        );
        browse::save(&state).map_err(|err| err.to_string())?;
        Ok::<_, String>(render_browse(
            &state,
            &format!("Completed sessions for {project_slug} / {work_item_id}"),
        ))
    })
    .await;
    result
        .unwrap_or_else(|err| Err(err.to_string()))
        .unwrap_or_else(|err| format!("Could not load sessions: {err}"))
}

async fn start_browse_recent(session_key: &SessionKey) -> String {
    let key = session_key.clone();
    let result = tokio::task::spawn_blocking(move || {
        let options = terminal_session_options(None, None)?;
        let state = browse::new_state(&key, BrowseLevel::Session, None, None, None, options);
        browse::save(&state).map_err(|err| err.to_string())?;
        Ok::<_, String>(render_browse(&state, "Recent completed sessions"))
    })
    .await;
    result
        .unwrap_or_else(|err| Err(err.to_string()))
        .unwrap_or_else(|err| format!("Could not load recent sessions: {err}"))
}

async fn move_browse_page(session_key: &SessionKey, forward: bool) -> String {
    let key = session_key.clone();
    let result = tokio::task::spawn_blocking(move || {
        let Some(mut state) = browse::load(&key).map_err(|err| err.to_string())? else {
            return Ok::<_, String>(
                "No project-tree navigation is active. Use `/session tree`.".to_string(),
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
        .unwrap_or_else(|err| format!("Could not change browse page: {err}"))
}

async fn browse_back(session_key: &SessionKey) -> String {
    let key = session_key.clone();
    let state = tokio::task::spawn_blocking(move || browse::load(&key)).await;
    let Ok(Ok(Some(state))) = state else {
        return "No project-tree navigation is active. Use `/session tree`.".to_string();
    };
    match state.level {
        BrowseLevel::Workspace => render_browse(&state, "Workspaces"),
        BrowseLevel::Project => start_browse_tree(session_key).await,
        BrowseLevel::WorkItem => start_browse_projects(session_key, state.workspace_id).await,
        BrowseLevel::Session => match (state.project_slug, state.work_item_id) {
            (Some(project_slug), Some(_)) => {
                start_browse_work_items(session_key, state.workspace_id, project_slug).await
            }
            _ => start_browse_tree(session_key).await,
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
    let expected_item = snapshot.work_item_id.clone();
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
        if expected_item.is_some() && record.work_item_id != expected_item {
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
            state.gateway_bindings.set(session_key.clone(), session_id.clone()).await;
            format!("Bound this chat to `{session_id}`. Latest completed terminal turn: `{terminal_turn_id}` ({terminal_turn_status}).")
        }
        Ok(Ok(false)) => "That session is no longer valid for this browse snapshot. Use `/session tree` or `/session recent` to refresh.".to_string(),
        Ok(Err(err)) => format!("Could not validate session: {err}"),
        Err(err) => format!("Could not validate session: {err}"),
    }
}

fn terminal_session_options(
    project_slug: Option<&str>,
    work_item_id: Option<&str>,
) -> Result<Vec<BrowseOption>, String> {
    let conn = database::db::get_connection().map_err(|err| err.to_string())?;
    let mut sql = String::from(
        "SELECT session_id, last_terminal_turn_id, last_terminal_turn_status
         FROM agent_sessions
         WHERE last_terminal_turn_id IS NOT NULL
           AND last_terminal_turn_status IN ('completed', 'cancelled', 'failed')",
    );
    if project_slug.is_some() {
        sql.push_str(" AND project_slug = ?1 AND work_item_id = ?2");
    }
    sql.push_str(" ORDER BY last_terminal_turn_at DESC, updated_at DESC LIMIT 64");
    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let mut rows = if let (Some(project_slug), Some(work_item_id)) = (project_slug, work_item_id) {
        stmt.query(rusqlite::params![project_slug, work_item_id])
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
        lines.push("No options at this level.".to_string());
    } else {
        for (index, option) in page.iter().enumerate() {
            lines.push(format!("{}. {}", index + 1, browse_option_label(option)));
        }
    }
    lines.push(format!(
        "Page {}/{} · `/next` `/prev` · `/0` back",
        state.page + 1,
        browse::page_count(state)
    ));
    lines.join("\n")
}

fn browse_heading(state: &BrowseState) -> &str {
    match state.level {
        BrowseLevel::Workspace => "Workspaces",
        BrowseLevel::Project => "Projects",
        BrowseLevel::WorkItem => "Work Items",
        BrowseLevel::Session => "Completed sessions",
    }
}

fn browse_option_label(option: &BrowseOption) -> String {
    match option {
        BrowseOption::Workspace { workspace_id } => workspace_id
            .clone()
            .unwrap_or_else(|| "Unlinked workspace".to_string()),
        BrowseOption::Project { project_slug, name } => format!("{project_slug} · {name}"),
        BrowseOption::WorkItem {
            work_item_id,
            title,
        } => format!("{work_item_id} · {title}"),
        BrowseOption::Session {
            session_id,
            terminal_turn_id,
            terminal_turn_status,
        } => {
            format!("{session_id} · terminal `{terminal_turn_id}` ({terminal_turn_status})")
        }
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
        blocks.push(format!(
            "**#{:02} · {}{}**\n{}\n`{}`\n{}\n{}",
            idx + 1,
            human_session_title(&s),
            current_badge,
            human_session_context(&s),
            s.session_id,
            human_session_relation(&s),
            terminal_turn_summary(&s.session_id),
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

fn human_session_relation(s: &crate::session::persistence::UnifiedSessionRecord) -> String {
    let mut parts = Vec::new();
    if let Some(project) = s.project_slug.as_deref().filter(|x| !x.trim().is_empty()) {
        parts.push(format!("项目 `{}`", project));
    }
    if let Some(item) = s.work_item_id.as_deref().filter(|x| !x.trim().is_empty()) {
        parts.push(format!("任务 `{}`", item));
    }
    if parts.is_empty() {
        parts.push("未绑定项目/任务".to_string());
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

/// The only "recent" turn signal exposed by browse surfaces.  It comes from
/// the terminal marker written by the turn lifecycle, not a message timestamp
/// or transcript scan, so in-progress output is never presented as complete.
fn terminal_turn_summary(session_id: &str) -> String {
    use rusqlite::OptionalExtension;

    let terminal = (|| {
        let conn = database::db::get_connection()?;
        conn.query_row(
            "SELECT last_terminal_turn_id, last_terminal_turn_status
             FROM agent_sessions WHERE session_id = ?1",
            [session_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()
    })();

    match terminal {
        Ok(Some((turn_id, status))) => match (turn_id, status) {
            (Some(turn_id), Some(status)) => format!("最新结束轮次：`{turn_id}`（{status}）"),
            _ => "最新结束轮次：暂无".to_string(),
        },
        Ok(None) => "最新结束轮次：不可用".to_string(),
        Err(_) => "最新结束轮次：不可用".to_string(),
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
                terminal_turn_summary(&sid)
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
        let ok = crate::session::persistence::update_project_link(
            &sid,
            &project.meta.org_id,
            &project.meta.id,
            &project.meta.name,
            &slug,
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
        "**ORG2 Channel Commands**",
        "These commands are handled inside the gateway before the OS agent runs, so they do **not** spend LLM tokens.",
        "",
        "**General**",
        "`/help` — show this list (alias: `/commands`).",
        "`/status` — show this chat's current binding and active runtime sessions.",
        "`/new` — clear this chat's binding; the next normal message creates a fresh session (alias: `/reset`).",
        "`/model <model>` — switch the current channel session model (aliases: gpt-5.5, sonnet, opus, fable).",
        "`/compact` — manually compact the current channel session and continue in a versioned successor.",
        "",
        "**Session switching**",
        "`/session current` — show the active channel-bound ORG2 session (alias: `/ctx current`).",
        "`/session list` — list recent ORG2 sessions (aliases: `/session ls`, `/ctx ls`).",
        "`/session switch <session_id>` — bind this Feishu chat to an existing session and show its completed terminal turn (alias: `/session use <session_id>`).",
        "`/session tree` — browse Workspace → Project → Work Item → completed Session without an LLM.",
        "`/session recent` — browse recent completed sessions without an LLM.",
        "`/next` / `/prev` — change a tree page; `/0` goes up one level; send a shown number to choose it.",
        "`/session new [name]` — create and bind a fresh session immediately.",
        "`/newsession <name> [prompt]` — create a named ORG2 session; with prompt, dispatch it into that session.",
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
            "/session tree",
            "/session recent",
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
}
