//! Build the worker's full system prompt (base soul + dynamic context +
//! conventions + learnings + scratchpad + environment section).

use std::path::Path;

use crate::definitions::builtin::EXPLORE_AGENT_ID;
use crate::definitions::{AgentDefinition, DelegationConfig};
use crate::tools::traits::ToolError;

use super::AgentTool;

impl AgentTool {
    /// Compose the worker's effective system prompt:
    /// 1. `agent.soul_content` (or default)
    /// 2. Dynamic context (built from `delegation_config.context_builders`)
    /// 3. Project conventions (write-capable workers only — read-only
    ///    explore stays slim, mirroring the reference's `omitClaudeMd`)
    /// 4. Learnings injection (memory/learnings)
    /// 5. Scratchpad directory section (when parent has one)
    /// 6. Environment section (every worker — reference parity with
    ///    `enhanceSystemPromptWithEnvDetails`, which is unconditional)
    pub(super) async fn build_full_system_prompt(
        &self,
        agent: &AgentDefinition,
        agent_id: &str,
        delegation_config: &DelegationConfig,
        model: &str,
        task_prompt: &str,
    ) -> Result<String, ToolError> {
        let base_prompt = agent
            .soul_content
            .clone()
            .unwrap_or_else(|| "You are a helpful assistant.".to_string());

        let dynamic_context = self.build_context(delegation_config).await;
        let scope = format!("agent:{}", agent_id);
        // Query-aware learnings: the worker's task text is the retrieval
        // query, so we can run the cross-encoder rerank stage
        // (`inject_learnings_into_prompt_reranked`) instead of the
        // query-less salience ranking. Falls back to salience internally
        // when embedding/rerank is unavailable.
        let learnings =
            crate::memory::learnings::inject_learnings_into_prompt_reranked(&scope, task_prompt)
                .await;
        let working_dir = self.resolve_repo_path().await;

        let mut extra_sections = Vec::new();
        if !dynamic_context.is_empty() {
            extra_sections.push(dynamic_context);
        }
        // Project conventions (CLAUDE.md / AGENTS.md / .orgii/agent-rules.md,
        // same loader as the parent prompt) go to write-capable workers so
        // implementation work honours repo rules without the parent having
        // to paste them into every worker prompt. Explore is read-only and
        // stays slim.
        if agent_id != EXPLORE_AGENT_ID {
            if let Some(conventions) = worker_conventions_section(&working_dir) {
                extra_sections.push(conventions);
            }
        }
        if !learnings.is_empty() {
            extra_sections.push(learnings);
        }
        if let Some(ref scratch) = self.config.scratchpad_dir {
            extra_sections.push(scratchpad_section(scratch));
        }

        // Presence stance (compact form): subagents can't ask the user
        // anything anyway, but the stance sets the decision-making
        // expectation ("decide yourself, list decisions in the report")
        // when the user is away/invisible — including custom modes.
        if let Some(presence) = crate::interaction::presence_state::global_presence() {
            if let Some(section) =
                crate::core::session::prompt::section_builders::format_user_presence_compact(
                    &presence,
                )
            {
                extra_sections.push(section);
            }
        }

        // Teach the model about its Agent Org participants.
        //
        // The worker's tool registry already carries `org_send_message`
        // (set up by `tool_assembly` and the org-aware overlay in
        // `agent::execute`), but unless the system prompt also documents
        // the org — coordinator, members, addressing rules — the model has
        // no idea who the org participants are or that messaging is the
        // right way to report back. Workers inherit the parent's
        // `agent_org_context` verbatim, but the worker's runtime identity
        // is the spawned agent id, not the parent session's member id.
        if let Some(ref org_context) = self.config.agent_org_context {
            extra_sections.push(
                crate::core::session::prompt::sections::build_agent_org_context_section(
                    org_context.as_ref(),
                    agent_id,
                    None,
                ),
            );
        }

        // Environment details close the prompt for EVERY worker (the
        // reference appends them unconditionally to subagent prompts).
        extra_sections.push(worker_env_section(&working_dir, model));

        let full_prompt = if extra_sections.is_empty() {
            base_prompt
        } else {
            format!("{}\n\n{}", base_prompt, extra_sections.join("\n\n"))
        };

        Ok(full_prompt)
    }
}

/// Compact environment block for worker system prompts: working dir,
/// platform, date, model. Day-precision date keeps the section stable
/// across a worker's (single-day) lifetime for prompt caching.
fn worker_env_section(working_dir: &Path, model: &str) -> String {
    format!(
        "# Environment\n\n\
         Working directory: {}\n\
         Platform: {} ({})\n\
         Today's date: {}\n\
         Model: {}",
        working_dir.display(),
        std::env::consts::OS,
        std::env::consts::ARCH,
        chrono::Local::now().format("%Y-%m-%d"),
        model
    )
}

/// Project-conventions section for write-capable workers. Reuses the
/// parent prompt's layered loader (`.orgii/agent-rules.md` + CLAUDE.md /
/// AGENTS.md + CLAUDE.local.md) and its 20K display cap.
fn worker_conventions_section(working_dir: &Path) -> Option<String> {
    let conventions = crate::core::session::prompt::helpers::load_conventions(working_dir)?;
    const MAX_CONVENTIONS_BYTES: usize = 20_000;
    let capped = if conventions.len() > MAX_CONVENTIONS_BYTES {
        format!(
            "{}\n\n[conventions truncated at {}KB]",
            crate::utils::safe_truncate_utf8(&conventions, MAX_CONVENTIONS_BYTES),
            MAX_CONVENTIONS_BYTES / 1000
        )
    } else {
        conventions
    };
    Some(format!("## Project Conventions\n\n{}", capped))
}

fn scratchpad_section(scratch: &Path) -> String {
    format!(
        "# Scratchpad Directory\n\n\
         Shared scratchpad directory (same as the parent session):\n\
         `{}`\n\n\
         Use this directory for ALL temporary file needs — intermediate results, \
         scripts, working files, or cross-worker knowledge. Files written here are \
         visible to the parent session and sibling workers. Only use `/tmp` if \
         the user explicitly requests it.",
        scratch.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_section_lists_cwd_platform_date_model() {
        let section = worker_env_section(Path::new("/repo/root"), "claude-fable-5");
        assert!(section.starts_with("# Environment"));
        assert!(section.contains("Working directory: /repo/root"));
        assert!(section.contains(&format!(
            "Platform: {} ({})",
            std::env::consts::OS,
            std::env::consts::ARCH
        )));
        assert!(section.contains("Model: claude-fable-5"));
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        assert!(section.contains(&today), "date must be day-precision today");
    }

    #[test]
    fn conventions_section_loads_claude_md() {
        let dir = std::env::temp_dir().join(format!(
            "worker-conventions-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("CLAUDE.md"), "Always run cargo fmt.").unwrap();

        let section = worker_conventions_section(&dir).expect("CLAUDE.md must produce a section");
        assert!(section.starts_with("## Project Conventions"));
        assert!(section.contains("Always run cargo fmt."));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn conventions_section_absent_without_memory_files() {
        let dir = std::env::temp_dir().join(format!(
            "worker-conventions-empty-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // NOTE: load_conventions walks up to 3 parents for CLAUDE.md /
        // AGENTS.md; the OS temp root is expected to carry none.
        assert!(worker_conventions_section(&dir).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }
}
