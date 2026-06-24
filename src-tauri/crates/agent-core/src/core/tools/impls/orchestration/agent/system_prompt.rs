//! Build the worker's full system prompt (base soul + dynamic context +
//! learnings + scratchpad section).

use std::path::Path;

use crate::definitions::{AgentDefinition, DelegationConfig};
use crate::tools::traits::ToolError;

use super::AgentTool;

impl AgentTool {
    /// Compose the worker's effective system prompt:
    /// 1. `agent.soul_content` (or default)
    /// 2. Dynamic context (built from `delegation_config.context_builders`)
    /// 3. Learnings injection (memory/learnings)
    /// 4. Scratchpad directory section (when parent has one)
    pub(super) async fn build_full_system_prompt(
        &self,
        agent: &AgentDefinition,
        agent_id: &str,
        delegation_config: &DelegationConfig,
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

        let mut extra_sections = Vec::new();
        if !dynamic_context.is_empty() {
            extra_sections.push(dynamic_context);
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

        let full_prompt = if extra_sections.is_empty() {
            base_prompt
        } else {
            format!("{}\n\n{}", base_prompt, extra_sections.join("\n\n"))
        };

        Ok(full_prompt)
    }
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
