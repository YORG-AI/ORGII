//! Prompt construction for `UnifiedMessageProcessor::process`.
//!
//! Two surfaces:
//!
//! - [`UnifiedMessageProcessor::build_system_prompt`] — stable prefix
//!   (cacheable across turns). Built from `SessionRuntime` so the same
//!   bytes are produced for every turn that doesn't rotate the agent
//!   definition.
//! - [`UnifiedMessageProcessor::build_dynamic_sections`] — per-turn
//!   context (hook prompts, skill listing, scratchpad path, background
//!   jobs reminder, todo nag, workspace memory). Lives in a separate
//!   `system` message so the stable prefix above can be cached by the
//!   Anthropic prompt-caching API.

use tracing::{info, warn};

use super::UnifiedMessageProcessor;
use crate::core::session::prompt::cache::SkillListingCacheKey;
use crate::core::session::prompt::sections::build_agent_org_context_section;
use crate::core::session::types::{SystemPromptConfig, ToolSummary};

impl UnifiedMessageProcessor {
    /// Builds the stable, cacheable system prompt.
    pub(in crate::core::session::turn) async fn build_system_prompt(
        &self,
        session_id: &str,
    ) -> String {
        let tool_summaries = self.build_tool_summaries();

        let live_workspace = Some(self.runtime.workspace_state.read().clone());

        let user_presence = self
            .ide_context
            .as_ref()
            .and_then(|ctx| ctx.user_presence.clone());
        let user_profile = self
            .ide_context
            .as_ref()
            .and_then(|ctx| ctx.user_profile.clone())
            .or_else(crate::interaction::profile_state::global_profile);

        let prompt_config = SystemPromptConfig {
            model: self.runtime.model.clone(),
            agent_id: self.agent_id.clone(),
            agent_definition_id: self.runtime.agent_definition_id.clone(),
            skills: self.runtime.resolved.skills.clone(),
            load_workspace_resources: self.runtime.resolved.load_workspace_resources,
            load_workspace_rules: self.runtime.resolved.load_workspace_rules,
            agent_soul: self.runtime.agent_soul.clone(),
            workspace: live_workspace,
            channel: self.channel.clone(),
            chat_id: self.chat_id.clone(),
            agent_mode: self.agent_mode,
            ide_context: self.ide_context.clone(),
            user_presence,
            user_profile,
            // Agent Org context includes the live task board and must be emitted
            // as a volatile follow-up system block below, not inside the
            // session-cacheable prefix.
            agent_org_context: None,
            agent_org_current_member_id: self.runtime.agent_org_current_member_id.clone(),
            sovereign_prompt: self.runtime.sovereign_prompt,
        };

        let mut prompt_cache = self.session.prompt_cache.lock().await;
        let mut learnings_prompt_cache = self.session.learnings_prompt_cache.lock().await;
        super::super::super::prompt::builder::build_unified_system_prompt_with_cache(
            session_id,
            &tool_summaries,
            &prompt_config,
            Some(&mut prompt_cache),
            Some(&mut learnings_prompt_cache),
        )
    }

    /// Builds the per-turn dynamic context sections.
    ///
    /// Concatenated (with `\n\n` separators) into a single follow-up
    /// `system` message by `process()` after the stable prompt. Order
    /// matters: hook prompts first, then skill listing, project
    /// memories, scratchpad path, background-jobs reminder, todo nag.
    pub(in crate::core::session::turn) async fn build_dynamic_sections(
        &self,
        session_id: &str,
        memory_prefetch_section: Option<&str>,
        user_message: Option<&str>,
    ) -> Vec<String> {
        let mut dynamic_sections: Vec<String> = Vec::new();

        if let Some(user_message) = user_message {
            if let Some(section) = crate::core::session::prompt::gui_control_retrieval::build_gui_control_relevant_controls_section(
                self.runtime.agent_definition_id.as_deref(),
                user_message,
            ) {
                dynamic_sections.push(section);
            }
        }

        // Apply .orgii/hooks.json prompt hooks (PrePromptBuild event)
        if let Some(ref executor) = self.event_handler_config.hook_executor {
            if let Some(hook_prompt) = executor
                .collect_prompt_hooks(crate::specialization::hooks::HookEvent::PrePromptBuild)
            {
                info!(
                    "[unified_processor] Injecting hook prompt content ({} chars)",
                    hook_prompt.len()
                );
                dynamic_sections.push(hook_prompt);
            }
        }

        if let Some(context) = self.runtime.agent_org_context.as_ref() {
            dynamic_sections.push(build_agent_org_context_section(
                context,
                &self.agent_id,
                self.runtime.agent_org_current_member_id.as_deref(),
            ));
        }

        // Skill listing attachment (per-turn name+description summary). Full SKILL.md
        // content is loaded via `read_file` when the LLM invokes it; the listing
        // itself lives in the dynamic section, not the stable system prompt.
        if self.runtime.resolved.skills.enabled {
            // `workspace_root()` returns `Some` for every wired session today
            // (Option is a future-proofing carry-over). Falling back to `.`
            // would let the SkillsLoader scan the agent's CWD, which is rarely
            // what the user expects and could leak skills from an unrelated
            // workspace into the LLM prompt. Skip the listing instead with a
            // diagnostic warn — same gating shape as the skill prefetch path
            // in `processor/mod.rs`.
            if let Some(ws_path) = self.workspace_root() {
                let skills_dir = ws_path.join(".orgii");

                let skills = &self.runtime.resolved.skills;
                let effective_disabled = skills.disabled.clone();
                let include_filter: Option<&[String]> = if skills.include.is_empty() {
                    None
                } else {
                    Some(skills.include.as_slice())
                };

                let agent_key = self
                    .runtime
                    .agent_definition_id
                    .as_deref()
                    .unwrap_or(self.agent_id.as_str());
                let cache_key = SkillListingCacheKey::new(
                    &ws_path,
                    &effective_disabled,
                    include_filter,
                    agent_key,
                    self.runtime.resolved.load_workspace_resources,
                );
                let listing = {
                    let mut cache = self.session.skill_listing_cache.lock().await;
                    let entries = match cache.get(&cache_key) {
                        Some(cached) => cached,
                        None => {
                            let mut loader = crate::skills::loader::SkillsLoader::new(&skills_dir)
                                .with_builtin_dir(crate::skills::loader::global_skills_dir())
                                .with_agent_id(agent_key.to_string())
                                .with_load_workspace_resources(
                                    self.runtime.resolved.load_workspace_resources,
                                );
                            if !self.runtime.resolved.skills.source_dirs.is_empty() {
                                loader = loader.with_extra_source_dirs(
                                    &self.runtime.resolved.skills.source_dirs,
                                );
                            }
                            let scanned = loader
                                .build_skill_listing_entries(&effective_disabled, include_filter);
                            cache.insert(cache_key, scanned.clone());
                            scanned
                        }
                    };
                    let delta_entries = cache.new_entries_for_agent(agent_key, &entries);
                    crate::skills::loader::SkillsLoader::format_skill_listing_entries(
                        &delta_entries,
                    )
                };
                if let Some(listing) = listing {
                    dynamic_sections.push(listing);
                }
            } else {
                warn!(
                    "[unified_processor] skill listing: workspace_root unexpectedly None; skipping",
                );
            }
        }

        // Inject workspace memories (relevance-selected from .orgii/workspace-memory/)
        if let Some(mem_section) = memory_prefetch_section {
            dynamic_sections.push(mem_section.to_string());
        }

        // Inject scratchpad directory context so the LLM has a concrete
        // per-session temp dir to write to instead of inventing /tmp paths.
        if self.runtime.native_harness_type.is_none() {
            if let Some(ws_path) = self.workspace_root() {
                if let Ok(scratch_dir) = app_paths::ensure_scratchpad(session_id, &ws_path) {
                    dynamic_sections.push(format!(
                    "# Scratchpad Directory\n\n\
                     IMPORTANT: Always use this scratchpad directory for temporary files \
                     instead of `/tmp` or other system temp directories:\n\
                     `{}`\n\n\
                     Use this directory for ALL temporary file needs:\n\
                     - Storing intermediate results or data during multi-step tasks\n\
                     - Writing temporary scripts or configuration files\n\
                     - Saving outputs that don't belong in the user's project\n\
                     - Creating working files during analysis or processing\n\
                     - Any file that would otherwise go to `/tmp`\n\n\
                     Only use `/tmp` if the user explicitly requests it.\n\n\
                     The scratchpad directory is session-specific, isolated from the user's project, \
                     and can be used freely without permission prompts.",
                    scratch_dir.display()
                    ));
                }
            }
        }

        // Background-jobs reminder — lists running/unacknowledged-completed
        // processes so the model doesn't have to call AwaitTool to notice them.
        {
            let jobs =
                crate::tools::impls::coding::exec::registry::list_jobs_for_reminder(session_id);
            if !jobs.is_empty() {
                dynamic_sections
                    .push(super::super::background_reminder::build_background_jobs_reminder(&jobs));
            }
        }

        // Todo nag reminder — nudges the model back to `manage_todo` after
        // NAG_THRESHOLD consecutive turns without a todo call. Injected as a
        // dynamic (non-persisted) section so the user-visible transcript is clean.
        const NAG_THRESHOLD: u32 = 3;
        {
            let rounds = *self.rounds_since_todo.lock().await;
            if rounds >= NAG_THRESHOLD {
                dynamic_sections.push(
                    "<system-reminder>If you are working on a multi-step task, \
                     remember to use the manage_todo tool to keep the task list \
                     up to date. Mark the current task in_progress and completed \
                     as you proceed.</system-reminder>"
                        .to_string(),
                );
                info!(
                    "[unified_processor] Nag reminder injected ({} turns since last todo call, session={})",
                    rounds, session_id
                );
            }
        }

        dynamic_sections
    }

    /// Build tool summaries from the same policy-filtered schema payload sent to the provider.
    fn build_tool_summaries(&self) -> Vec<ToolSummary> {
        let effective_policy = self.effective_tool_policy();
        self.runtime
            .tool_registry
            .prompt_tool_summaries(effective_policy.as_ref())
            .into_iter()
            .map(|(name, description)| ToolSummary { name, description })
            .collect()
    }
}
