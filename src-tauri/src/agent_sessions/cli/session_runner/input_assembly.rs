//! Prompt assembly for CLI sessions.
//!
//! Builds the effective user input sent to the agent: exec-mode bridge
//! preamble, prior-conversation context bridge, attached-image references,
//! and (for ACP agents without native rules-file sync) an inline skills
//! injection. Extracted from `session::run_session` to keep the runner's
//! orchestration readable.

use agent_core::session::AgentExecMode;
use key_vault::key_store::ModelType;

use super::context_bridge::build_context_bridge;

/// Maps a per-session exec mode to the `<orgii_cli_exec_mode_bridge>` preamble
/// injected ahead of the user's prompt. `Wingman` (and any unparseable mode)
/// contributes no preamble.
pub(super) fn cli_exec_mode_bridge(mode: Option<&str>) -> Option<&'static str> {
    let mode = mode.and_then(AgentExecMode::parse)?;
    match mode {
        AgentExecMode::Plan => Some(concat!(
            "<orgii_cli_exec_mode_bridge>\n",
            "You are running inside ORGII PLAN mode. Plan mode is read-only unless the user explicitly approves Build later. ",
            "Do not implement, edit source files, run shell commands, or create the acceptance artifact.\n",
            "- If the user asks to draft, create, update, revise, or submit an approval plan, use an ORGII plan tool such as create_plan, EnterPlanMode/ExitPlanMode, or a plan-file workflow if available.\n",
            "- If no plan tool is available for an explicit plan request, write the plan as a markdown file (e.g. `plan.md`) with a title and concrete Build steps; ORGII canonicalizes the written plan file into the approval card.\n",
            "- If the user asks an ordinary question, asks for clarification, or explicitly says not to modify the pending plan, answer the question directly and do not create, revise, or submit a plan.\n",
            "- After submitting/outputting an approval plan, stop.\n",
            "</orgii_cli_exec_mode_bridge>"
        )),
        AgentExecMode::Build => Some(concat!(
            "<orgii_cli_exec_mode_bridge>\n",
            "You are running inside ORGII BUILD mode. Execute the approved or requested work directly. ",
            "Do not create a new approval plan unless the user explicitly asks to switch back to Plan mode.\n",
            "</orgii_cli_exec_mode_bridge>"
        )),
        AgentExecMode::Ask => Some(concat!(
            "<orgii_cli_exec_mode_bridge>\n",
            "You are running inside ORGII ASK mode. Research and answer without editing files, applying patches, deleting files, or running write commands.\n",
            "</orgii_cli_exec_mode_bridge>"
        )),
        AgentExecMode::Debug => Some(concat!(
            "<orgii_cli_exec_mode_bridge>\n",
            "You are running inside ORGII DEBUG mode. Focus on diagnosis and evidence. Avoid implementation changes unless explicitly requested.\n",
            "</orgii_cli_exec_mode_bridge>"
        )),
        AgentExecMode::Review => Some(concat!(
            "<orgii_cli_exec_mode_bridge>\n",
            "You are running inside ORGII REVIEW mode. Inspect changes and produce a review verdict without modifying files.\n",
            "</orgii_cli_exec_mode_bridge>"
        )),
        AgentExecMode::Wingman => None,
    }
}

/// Assemble the effective prompt from the raw user input plus the CLI-session
/// preambles. `is_fresh_session` is true when there is no `cli_resume_id`
/// (only a fresh conversation gets the prior-context bridge). `skills_enabled`
/// / `disabled_skills` come from the resolved SDE skills config.
#[allow(clippy::too_many_arguments)]
pub(super) fn build_effective_input(
    user_input: &str,
    mode: Option<&str>,
    session_id: &str,
    is_fresh_session: bool,
    agent: &ModelType,
    image_paths: &[String],
    use_codex_app_server: bool,
    repo_path: Option<&str>,
    skills_enabled: bool,
    disabled_skills: &[String],
) -> String {
    let mut effective_input = user_input.to_string();

    if let Some(exec_mode_bridge) = cli_exec_mode_bridge(mode) {
        effective_input = format!("{}\n\n{}", exec_mode_bridge, effective_input);
    }

    if is_fresh_session {
        if let Some(context_bridge) = build_context_bridge(session_id) {
            effective_input = format!("{}\n\n{}", context_bridge, effective_input);
        }
    }

    if !image_paths.is_empty() && !agent.is_acp() && !use_codex_app_server {
        let refs: Vec<String> = image_paths
            .iter()
            .enumerate()
            .map(|(idx, path)| format!("Image {}: {}", idx + 1, path))
            .collect();
        effective_input = format!(
            "{}\n\nIMPORTANT: The user attached {} image(s). You MUST read each image file below before responding. Use your read_file or view_image tool on these absolute paths:\n{}",
            effective_input,
            image_paths.len(),
            refs.join("\n"),
        );
    }

    // For ACP agents without native rules file sync, inject skills into the prompt.
    // Reuse the already-resolved skills config (§11.4 row 17).
    if matches!(agent, ModelType::Kiro | ModelType::OpenCode) {
        if let Some(path) = repo_path {
            if let Some(skills_block) = super::super::skill_sync::build_skills_prompt_injection(
                std::path::Path::new(path),
                skills_enabled,
                disabled_skills,
            ) {
                effective_input = format!("{}\n\n{}", skills_block, effective_input);
            }
        }
    }

    effective_input
}
