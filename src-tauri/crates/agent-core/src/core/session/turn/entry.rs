//! Integration helpers for unified agent session framework.
//!
//! This module provides a single entry point for processing messages
//! across all agent types (OS, SDE, Custom).

use std::sync::Arc;

use tauri::Manager;

use crate::state::AgentSession;

use super::super::types::{ProcessingContext, ProcessingResult};
use super::event_handler::EventHandlerConfig;
use super::processor::{TurnInput, UnifiedMessageProcessor};

/// Extract the LSP manager from a Tauri app handle (if available).
fn extract_lsp_manager(
    app_handle: &Option<tauri::AppHandle>,
) -> Option<Arc<tokio::sync::Mutex<lsp::LspManager>>> {
    app_handle
        .as_ref()
        .and_then(|h| h.try_state::<lsp::LspManagerState>())
        .map(|s: tauri::State<'_, lsp::LspManagerState>| s.inner().clone())
}

/// Extract the screenshot store from a Tauri app handle, falling back to an
/// empty store when the handle is unavailable (e.g. test/public endpoints).
fn extract_screenshot_store(
    app_handle: &Option<tauri::AppHandle>,
) -> Arc<shared_state::ScreenshotStore> {
    use crate::state::AgentAppState;
    app_handle
        .as_ref()
        .and_then(|h| h.try_state::<AgentAppState>())
        .map(|s| Arc::clone(&s.screenshot_store))
        .unwrap_or_else(|| Arc::new(shared_state::ScreenshotStore::new()))
}

// ============================================
// Skill Slash Command Expansion
// ============================================

/// Expand a skill slash command (e.g. `/create-rule`) into the full SKILL.md content.
///
/// If the user message starts with `/name` and `name` resolves to a known skill, the
/// SKILL.md body is injected as the leading context so the LLM receives the full skill
/// instructions. Any trailing user args are appended as `User task: ...`. The original
/// `/name` token stays in the transcript so resume/replay sees what the user typed,
/// while the LLM sees the rendered prompt.
///
/// Returns the original `content` unchanged if no matching skill is found.
/// Expand a skill slash command (e.g. `/create-rule`) into the full SKILL.md content.
///
/// **workspace = None behavior**: when there is no project context (e.g. OS Agent sessions),
/// `workspace` is None and is treated as an empty path. Built-in skills are still resolved
/// via `global_skills_dir()`. Project-level custom skills are NOT visible — the loader will
/// look for `.orgii/skills/<name>/SKILL.md` relative to cwd, which typically does not exist.
/// Unknown slash commands fall through silently (original content is returned unchanged).
/// This is intentional: project skills require a project context.
///
/// **workspace path contract**: callers pass the workspace root (`workspace_path`). This function
/// internally joins `.orgii` so the loader scans `{project}/.orgii/skills/`, matching the
/// canonical project skill location documented in `create-skill/SKILL.md`.
fn expand_skill_slash_command(content: &str, workspace: Option<&std::path::Path>) -> String {
    let trimmed = content.trim_start();
    if !trimmed.starts_with('/')
        || trimmed.len() <= 1
        || !trimmed.as_bytes()[1].is_ascii_alphanumeric()
    {
        return content.to_string();
    }

    let command_end = trimmed
        .char_indices()
        .find_map(|(idx, ch)| ch.is_whitespace().then_some(idx))
        .unwrap_or(trimmed.len());
    let slash_name = trimmed[..command_end].trim_start_matches('/');

    let ws_root = workspace.unwrap_or_else(|| std::path::Path::new(""));
    let ws = ws_root.join(".orgii");
    let loader = crate::specialization::skills::loader::SkillsLoader::new(&ws)
        .with_builtin_dir(crate::specialization::skills::loader::global_skills_dir());

    let Some(skill_md) = loader.load_skill(slash_name) else {
        return content.to_string();
    };

    tracing::info!(
        "[integration] Skill slash command: /{} ({} chars)",
        slash_name,
        skill_md.len()
    );

    let user_args = trimmed[command_end..].trim().to_string();
    if user_args.is_empty() {
        skill_md
    } else {
        format!("{}\n\n---\n\nUser task: {}", skill_md, user_args)
    }
}

#[cfg(test)]
mod tests {
    use super::expand_skill_slash_command;

    #[test]
    fn skill_slash_command_accepts_newline_after_name() {
        let expanded = expand_skill_slash_command(
            "/e2e-testing\nrun the relevant frontend spec",
            Some(std::path::Path::new("/tmp/nonexistent-orgii-workspace")),
        );

        assert!(
            expanded.contains("# Agent E2E Testing"),
            "expected bundled e2e-testing skill content, got prefix: {:?}",
            &expanded[..expanded.len().min(120)]
        );
        assert!(
            expanded.contains("User task: run the relevant frontend spec"),
            "expected newline tail to become the user task"
        );
    }
}

// ============================================
// Unified Process Function
// ============================================

/// Process a message using the unified framework.
///
/// This is the **SINGLE** entry point for all session-backed agent types.
/// The processor reads session-level data directly from `Arc<SessionRuntime>`
/// (held by the session) — zero relay structs.
///
/// `app_handle` provides access to app-level singletons (`AgentAppState`,
/// `LspManagerState`). Callers with a Tauri context pass `Some(handle)`;
/// test/public endpoints pass `None` for graceful degradation.
pub async fn process_message(
    session: Arc<AgentSession>,
    input: TurnInput,
    app_handle: Option<tauri::AppHandle>,
) -> Result<ProcessingResult, String> {
    let runtime = session
        .runtime
        .read()
        .await
        .as_ref()
        .ok_or_else(|| format!("Session {} runtime not initialized", session.id))?
        .clone();

    let workspace_path = runtime.workspace_state.read().working_dir().to_path_buf();

    let lsp_manager = extract_lsp_manager(&app_handle);
    let screenshot_store = extract_screenshot_store(&app_handle);

    let hook_executor = Arc::new(
        crate::specialization::hooks::HookExecutor::load_with_workspace_scope(
            &workspace_path,
            runtime.resolved.load_workspace_resources,
        ),
    );

    // Fire HookEvent::NotificationReceived — this is the single entry point
    // for inbound user messages, matching the event's declared contract.
    crate::specialization::hooks::dispatch::fire_notification_received(
        &hook_executor,
        &session.id,
        &input.content,
    );

    if let Some(plan_approval_manager) = session.plan_approval_manager.as_ref() {
        plan_approval_manager.set_app_handle(app_handle.clone());
    }

    let event_handler_config = EventHandlerConfig {
        workspace_path: Some(workspace_path.clone()),
        lsp_manager,
        app_handle: app_handle.clone(),
        hook_executor: Some(hook_executor),
        turn_id: input.turn_id.clone(),
        cancel_flag: Some(Arc::clone(&session.cancel_flag)),
        active_turn_generation: Some(Arc::clone(&session.active_turn_generation)),
        active_repo_path: input
            .ide_context
            .as_ref()
            .and_then(|ctx| ctx.repo_path.clone()),
        agent_org_task_lifecycle: None,
    };

    let policy = Arc::clone(&runtime.policy);

    let processor = UnifiedMessageProcessor::new(super::processor::ProcessorParams {
        runtime: Arc::clone(&runtime),
        session: Arc::clone(&session),
        policy,
        channel: input.channel.clone(),
        chat_id: input.chat_id.clone(),
        agent_mode: input.agent_mode,
        ide_context: input.ide_context.clone(),
        app_handle,
        screenshot_store,
        event_handler_config,
    });

    let processing_context = ProcessingContext {
        images: input.images,
        is_resume: input.is_resume,
        display_text: input.display_text,
        turn_id: input.turn_id,
        turn_intent_id: input.turn_intent_id,
    };

    let content = expand_skill_slash_command(&input.content, Some(workspace_path.as_path()));

    let (ide_repo_path, workspace_folders) = input
        .ide_context
        .as_ref()
        .map(|ctx| (ctx.repo_path.as_deref(), ctx.workspace_folders.as_slice()))
        .unwrap_or((None, &[]));

    let skill_ws = workspace_path.join(".orgii");
    let skill_loader_fn = |name: &str| -> Option<String> {
        let loader = crate::specialization::skills::loader::SkillsLoader::new(&skill_ws)
            .with_builtin_dir(crate::specialization::skills::loader::global_skills_dir());
        loader.load_skill(name)
    };

    let content = crate::utils::pill_resolver::expand_pill_references(
        &content,
        &workspace_path,
        ide_repo_path,
        workspace_folders,
        Some(&skill_loader_fn as &dyn Fn(&str) -> Option<String>),
    );

    processor
        .process(&session.id, &content, processing_context)
        .await
}
