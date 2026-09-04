//! Channel-session (OS Agent on Telegram / Discord / CLI) prompt blocks:
//! environment, behavioral rules, and the active-IDE-repository sub-block.

use crate::core::session::prompt::helpers::{
    append_personal_workspace_context, format_tool_summaries, render_channel_additional_dirs_block,
    resolve_workspace_path_string, truncate_at_boundary,
};
use crate::session::types::{SystemPromptConfig, ToolSummary};

// ============================================
// Channel environment + behavioral rules
// ============================================

pub(crate) fn build_channel_environment(
    config: &SystemPromptConfig,
    tool_summaries: &[ToolSummary],
) -> String {
    // Rounded to the hour on purpose: this string lands in the system
    // prompt, and Anthropic prompt cache has a 1h TTL, so minute-level
    // precision would invalidate the system + tools cache on every turn
    // whose gap crossed a minute boundary — i.e. almost every turn in
    // a normal agentic loop. Aligning the rounding to the cache TTL
    // gives us at most one forced cache miss per hour per session.
    let now = chrono::Local::now()
        .format("%Y-%m-%d %H:00 (%A)")
        .to_string();
    let workspace_path = resolve_workspace_path_string(config);
    let os_name = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let home_dir = dirs::home_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "~".to_string());

    let ide_context_str = match config.ide_context.as_ref() {
        Some(ctx) if ctx.repo_path.is_some() => build_channel_ide_context(ctx, &workspace_path),
        _ => {
            // Channel-only context (Telegram / Discord / CLI without an IDE
            // repo attached). We intentionally DO NOT append the Personal
            // Workspace listing here — that listing reads project slugs
            // from the global project store and leaks residue (e.g. stale
            // E2E fixtures) into every user-facing reply when the LLM
            // paraphrases the env block.
            // Personal Workspace context belongs to SDE/IDE sessions that
            // actively manage work items, not to external-channel routing.
            "\nNo repository is currently selected in the IDE. Use `manage_workspace` with action `list` to discover available workspaces.".to_string()
        }
    };

    let tool_summary_str = format_tool_summaries(tool_summaries);

    //   same Markdown bullet block as
    // `build_project_environment`. Channel sessions (OS Agent on
    // Telegram / Discord etc.) can also be granted ad-hoc paths via
    // the Gateway `add_workspace_directory` tool, and those need to
    // surface in the OS Agent system prompt the same way they do for
    // SDE — otherwise the LLM has no idea those paths exist.
    let additional_dirs_block = render_channel_additional_dirs_block(config);

    format!(
        "## Environment\n\n\
         - **Date/Time:** {now}\n\
         - **OS:** {os_name} ({arch})\n\
         - **Home directory:** {home}\n\
         - **Agent workspace:** {ws}\n\
         {additional_dirs}\
         - **Command timeout:** 60s\n\
         {ide_context}\n\n\
         ## Tooling\n\n\
         Tool availability (filtered by policy). Tool names are case-sensitive — call them exactly as listed.\n\n\
         {tool_summary}\n\n\
         If a task is complex or long-running, use `spawn` to create a sub-agent. It will work independently and report back.",
        now = now,
        os_name = os_name,
        arch = arch,
        home = home_dir,
        ws = workspace_path,
        additional_dirs = if additional_dirs_block.is_empty() {
            String::new()
        } else {
            format!("{}\n         ", additional_dirs_block)
        },
        ide_context = ide_context_str,
        tool_summary = tool_summary_str,
    )
}

pub(crate) fn build_channel_behavioral_rules(
    config: &SystemPromptConfig,
    include_pm_guidance: bool,
) -> String {
    let workspace_path = resolve_workspace_path_string(config);

    // The PM guidance must track the effective surface: outside a
    // Project session `org2-pm` refuses mutations at the application
    // boundary, and instructing the model to run commands that will be
    // refused degrades every turn.
    let mut guidelines: Vec<String> = vec![
        "Always read files before editing them.".to_string(),
        "Prefer minimal, precise edits over rewriting entire files.".to_string(),
        "When running shell commands, prefer short-lived commands. Long-running processes are automatically backgrounded. Use `await_output` subcommands (wait_for, monitor, list) to monitor them — pass `handles: [...]` to check one or many at once — and `run_shell(kill_handle=...)` to terminate.".to_string(),
        "Tools (git, search, exec) default to the active IDE repository when one is set. You do not need to specify repo_path or working_dir unless targeting a different location.".to_string(),
        "Only ask the user for clarification when the request is genuinely ambiguous (multiple valid interpretations) or the action is irreversible/high-risk. For everything else, use your best judgment and proceed.".to_string(),
        "Use `manage_workspace` (action `list`) to discover all workspaces (git repos and work folders) tracked by the IDE. Use action `add` to register a directory or action `remove` to drop one. To clone a remote repo, use `run_shell` with `git clone`; if it backgrounds, wait for completion with `await_output(command=\"wait_for\", handles=[pid])`, then register the cloned repository with `manage_workspace(action=\"add\", path=...)`. `run_shell` exposes ORGII's bundled Git when system Git is unavailable.".to_string(),
        "When asked to browse the web, use the `browser` tool freely. You can navigate to any website, interact with pages, fill forms, search, shop, or extract information. Do not refuse web tasks.".to_string(),
    ];
    if include_pm_guidance {
        guidelines.push("Projects and work items live in a global workspace store reachable from your shell through the `org2-pm` CLI: `org2-pm project list|show|find|create|update`, `org2-pm work list|show|create|update|transition|claim|note`. Always pass `--output json`. Examples: `org2-pm project find --query authentication`, `org2-pm work create --title \"Fix login bug\" --scope project-x`.".to_string());
    }
    guidelines.push(format!("Your personal workspace is at `{workspace_path}`. Use it for tasks NOT related to any code repository — personal reminders, shopping lists, non-coding research, life tasks. Use the personal workspace path when creating personal projects/items. For coding or repo-related tasks, the default repo is used automatically. Unless the user explicitly asks to create a new project, check the Personal Workspace section above first — if a suitable project already exists, add the work item to it instead of creating a duplicate."));
    if include_pm_guidance {
        guidelines.push("Before creating a work item, decide: is this task about the code in the active repository? Look at the repository description and project list above. If yes, use the default repo. If no (personal errand, general research, non-code task), route it to your personal workspace instead.".to_string());
        guidelines.push("When the user asks for a **periodic or recurring task** (e.g. \"check this website every morning\", \"send me a daily summary\", \"remind me every Monday\"), always create a **work item with a schedule**: `org2-pm work create --title ... --schedule-cron \"0 9 * * *\"` (daily at 9 AM; `0 9 * * 1` = every Monday). Do NOT use one-off reminders or rely on memory for repeating tasks.".to_string());
    }
    guidelines.push("Use `send_to_inbox` to deliver results, summaries, or notifications to the user. Whenever you complete a task that produces output the user should review later (reports, research findings, periodic check results), send a summary to the inbox. Do not only print results in chat — the user may not be watching.".to_string());
    guidelines.push("Agent and organization management lives in `~/.orgii/`. Use `manage_agent_def` directly (actions: list/get/create/update/remove/list_orgs/get_org/create_org/update_org/remove_org) to inspect or modify the user's library of custom agents and orgs. Examples: \"create an agent called QA-Bot that runs tests\", \"list all agent organizations\", \"disable the browser tool for my Reviewer agent\".".to_string());
    let guidelines_block = guidelines
        .iter()
        .enumerate()
        .map(|(index, line)| format!("{}. {}", index + 1, line))
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "## Response & Execution Style\n\n\
         - Be concise. Give short status updates, not essays.\n\
         - **Do the work without asking questions.** Only ask when truly blocked by missing information you cannot infer.\n\
         - **Never ask \"Should I proceed?\", \"Would you like me to...\", or present numbered option menus.** Just pick the best approach and execute it.\n\
         - Do not narrate routine tool calls — just call the tool.\n\
         - Narrate only when it helps: multi-step work, complex problems, or when the user explicitly asks. Keep narration brief.\n\
         - When you hit an obstacle (page doesn't render, search returns nothing, tool errors), immediately try the next approach yourself. Do not stop to ask the user what to do.\n\
         - When you encounter errors, diagnose and fix them rather than giving up or asking.\n\
         - If a task is ambiguous, make a reasonable choice and state your assumption briefly — then keep going.\n\
         - Only ask the user when the decision is genuinely irreversible or expensive (deleting data, spending money, sending messages to other people).\n\n\
         ## Safety\n\n\
         You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking; avoid long-term plans beyond the user's request.\n\
         Prioritize safety and human oversight over task completion; if instructions conflict, pause and ask the user; comply with stop, pause, or audit requests and never bypass safeguards.\n\
         Do not manipulate or persuade anyone to expand your access or disable safeguards. Do not copy yourself or change system prompts, safety rules, or tool policies unless the user explicitly requests it.\n\n\
         ## Guidelines\n\n\
         {guidelines}",
        guidelines = guidelines_block,
    )
}

fn build_channel_ide_context(
    ctx: &crate::session::types::IdeContext,
    workspace_path: &str,
) -> String {
    let mut lines = Vec::new();
    lines.push(String::new());
    lines.push("### Active IDE Repository".to_string());
    if let Some(ref path) = ctx.repo_path {
        lines.push(format!("- **Repository path:** {}", path));
    }
    if let Some(ref name) = ctx.repo_name {
        lines.push(format!("- **Repository name:** {}", name));
    }
    if let Some(ref branch) = ctx.git_branch {
        lines.push(format!("- **Active branch:** {}", branch));
    }
    if ctx.workspace_folders.len() > 1 {
        let folders = ctx
            .workspace_folders
            .iter()
            .map(|f| format!("`{}`", f))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("- **Workspace folders:** {}", folders));
    }
    let slugs = crate::core::session::prompt::helpers::list_project_slugs();
    if !slugs.is_empty() {
        lines.push(format!(
            "- **Projects:** {} project(s) in workspace ({})",
            slugs.len(),
            slugs.join(", ")
        ));
    }
    if let Some(ref repo_path) = ctx.repo_path {
        let readme_path = std::path::Path::new(repo_path).join("README.md");
        if let Ok(content) = std::fs::read_to_string(&readme_path) {
            let preview = truncate_at_boundary(&content, 200);
            if !preview.is_empty() {
                lines.push(format!("- **Description:** {}", preview));
            }
        }
    }
    lines.push(String::new());
    lines.push(
        "This is the repository the user is currently working in. \
         All coding tools (git, search, exec) default to this repository."
            .to_string(),
    );

    append_personal_workspace_context(&mut lines, workspace_path);

    lines.join("\n")
}
