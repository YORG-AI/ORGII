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
use crate::core::session::prompt::sections::build_agent_org_context_section_with_task_snapshot;
use crate::core::session::types::{SystemPromptConfig, ToolSummary};

fn render_orgtrack_cli_brief(
    product_mode: Option<&str>,
    project_slug: Option<&str>,
) -> Option<String> {
    if product_mode != Some("project") {
        return None;
    }
    let scope_line = match project_slug {
        Some(slug) => format!("Your scope is injected (ORGII_SCOPE={slug}); omit --scope."),
        None => "No Project is required. This session uses the current organization's standalone Work Item scope; omit --scope. Work list/create route there automatically.".to_string(),
    };
    Some(format!(
        "## Work Management (org2-pm)\n\n\
         The work system is also reachable from your shell through the `org2-pm` CLI. \
         Use `--output json`; run `org2-pm --help` or `org2-pm <command> --help` for anything beyond the core set.\n\n\
         - `org2-pm work show <id>` / `org2-pm work list [--status <state>] [--ready]`\n\
         - `org2-pm work create --title \"...\" [--body ...] [--parent <id>]`\n\
         - `org2-pm work update <id> [--title ...] [--body ...|--body-file <path>] [--expected-revision N]`\n\
         - `org2-pm work transition <id> --to <state> --reason \"...\"`\n\
         - `org2-pm work claim <id>` / `org2-pm work release <id>`\n\
         - `org2-pm work note <id> --kind <comment|progress|blocker|decision|handoff|review> --body \"...\"`\n\n\
         For multi-line or code-bearing bodies, write the text to a file in your working \
         directory and pass `--body-file <path>` — inline --body goes through the shell, \
         which mangles backticks and $().\n\n\
         Rules:\n\
         - Your session identity is injected; never pass --actor yourself.\n\
         - {}\n\
         - Split the work into sub items (`work create --parent <id>`) whenever the plan has \
         more than one independently completable step; keep single-step work on the item itself.\n\
         - When you finish working an item, post exactly ONE receipt on it — \
         `org2-pm work note <id> --kind progress --body \"...\"` — stating the outcome, not the \
         process. Do NOT post progress updates or plans as notes while you work. Chat text is \
         not delivered to the work item; only notes land on it.\n\
         - If blocked, run `org2-pm work transition <id> --to blocked --reason \"...\"` and post \
         one note explaining the blocker.\n\
         - Your harness's built-in planning tools (task lists, todos) are local scratch state — \
         they do NOT update the work system. Only `org2-pm` writes count.",
        scope_line
    ))
}

fn render_linked_work_item_context(work_item_id: &str, project_slug: Option<&str>) -> String {
    let (scope_instruction, standalone_flag) = match project_slug {
        Some(project_slug) => (
            format!(
                "Pass `--scope {}` on every `org2-pm work` command for this item (or rely on the injected ORGII_SCOPE).",
                project_slug
            ),
            "",
        ),
        None => (
            "This item is standalone (no project): pass `--standalone` on every `org2-pm work` command for it and omit `--scope`."
                .to_string(),
            " --standalone",
        ),
    };

    format!(
        "## Linked Work Item\n\n\
         This planning session is already linked to Work Item {}. \
         {} \
         Use the `org2-pm` CLI from your shell to read and fill it: `org2-pm work show <id>{}` to read, \
         `org2-pm work update <id>{} --title \"...\" --body \"...\"` to fill or refine the draft. \
         ⚠️ Every deliverable of this session MUST land on the Work Item through `org2-pm` — \
         whatever the user asks for here IS this item's content: write it into the item body \
         (and sub items via `org2-pm work create{} --parent {}` when the work has multiple \
         independently completable steps), then post one receipt with \
         `org2-pm work note <id>{} --kind progress --body \"...\"`. \
         Chat replies are conversation, not delivery; a turn that ends with the work only in \
         chat has delivered nothing, even when the content itself is correct. \
         Scope rule: the linked item is THIS session's original deliverable. \
         When the user iterates on that same request (refine, expand, correct, retitle), update the linked draft instead of creating a duplicate. \
         When the user asks for a NEW or additional Work Item — a different topic, an example, \"another one\" — create a fresh item with `org2-pm work create{} --title \"...\"` and leave the linked item untouched; never repurpose it by overwriting its title and body with unrelated content. \
         Apply all of this silently: never announce the linkage, ids, or drafting mechanics to the user (no \"this session is already linked to…\") — just acknowledge the request and do the work.",
        serde_json::to_string(work_item_id).expect("work item id is JSON serializable"),
        scope_instruction,
        standalone_flag,
        standalone_flag,
        standalone_flag,
        serde_json::to_string(work_item_id).expect("work item id is JSON serializable"),
        standalone_flag,
        standalone_flag,
    )
}

fn linked_work_item_context_for_session(
    product_mode: Option<&str>,
    work_item_id: Option<&str>,
    project_slug: Option<&str>,
) -> Option<String> {
    if product_mode != Some("project") {
        return None;
    }
    work_item_id.map(|work_item_id| render_linked_work_item_context(work_item_id, project_slug))
}

impl UnifiedMessageProcessor {
    /// Builds the system prompt split into `(stable, volatile)` bodies.
    ///
    /// `stable` is the cacheable prefix; `volatile` holds the per-turn
    /// sections (environment, IDE context, presence, mode suffix, …) and is
    /// appended after the history by `process()` so it never breaks the
    /// provider prompt-cache prefix.
    pub(in crate::core::session::turn) async fn build_system_prompt(
        &self,
        session_id: &str,
    ) -> (String, String) {
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

        let product_mode = tokio::task::block_in_place(|| {
            super::unified_persistence::get_session(session_id)
                .ok()
                .flatten()
                .and_then(|record| record.product_mode)
        });

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
            product_mode,
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
        super::super::super::prompt::builder::build_unified_system_prompt_split_with_cache(
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
    ) -> (Vec<String>, Option<i64>) {
        let mut dynamic_sections: Vec<String> = Vec::new();
        let mut coordinator_presented_work_revision = None;

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
            let context_snapshot = context.clone();
            let current_agent_id = self.agent_id.clone();
            let current_member_id = self.runtime.agent_org_current_member_id.clone();
            let coordinator_prompt = current_member_id.as_deref()
                == Some(crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID);
            match tokio::task::spawn_blocking(move || {
                let (task_snapshot, presented_revision) = if coordinator_prompt {
                    match crate::coordination::agent_org_runs::AgentOrgRunStore::stage_coordinator_work_revision_and_load_tasks(
                        &context_snapshot.run_id,
                    ) {
                        Ok((revision, tasks)) => (Ok(tasks), revision),
                        Err(error) => (Err(error), None),
                    }
                } else {
                    (
                        crate::coordination::agent_org_tasks::AgentOrgTaskStore::list_operational(
                            &context_snapshot.run_id,
                        ),
                        None,
                    )
                };
                (
                    build_agent_org_context_section_with_task_snapshot(
                        &context_snapshot,
                        &current_agent_id,
                        current_member_id.as_deref(),
                        task_snapshot,
                    ),
                    presented_revision,
                )
            })
            .await
            {
                Ok((section, revision)) => {
                    dynamic_sections.push(section);
                    coordinator_presented_work_revision = revision;
                }
                Err(error) => {
                    warn!(
                        run_id = %context.run_id,
                        error = %error,
                        "[unified_processor] Agent Org task snapshot construction failed"
                    );
                    dynamic_sections.push(format!(
                        "## Agent Org Run\n\n- Task board snapshot unavailable: background snapshot task failed ({error}). Call `task_list` before changing task state."
                    ));
                }
            }
        }

        // Every Project-mode entrance owns a durable linked Work Item. Keep
        // that identity in the per-turn prompt even when an orchestrator also
        // supplied launch context: ordinary SDE sessions bootstrap the link
        // after launch, and without this live row the model rediscovers
        // projects, creates duplicates, or asks for a scope that is optional.
        // Keep this volatile because the bootstrap link is session-specific.
        {
            let linked_session =
                tokio::task::block_in_place(|| super::unified_persistence::get_session(session_id));
            match linked_session {
                Ok(Some(session)) => {
                    if let Some(context) = linked_work_item_context_for_session(
                        session.product_mode.as_deref(),
                        session.work_item_id.as_deref(),
                        session.project_slug.as_deref(),
                    ) {
                        dynamic_sections.push(context);
                    }
                    if let Some(brief) = render_orgtrack_cli_brief(
                        session.product_mode.as_deref(),
                        session.project_slug.as_deref(),
                    ) {
                        dynamic_sections.push(brief);
                    }
                }
                Ok(None) => {}
                Err(error) => warn!(
                    session_id,
                    error = %error,
                    "[unified_processor] Failed to load linked Work Item prompt context"
                ),
            }
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
        // Completed subagents' final results are INLINED in the reminder and
        // acknowledged here, so the parent acts on them without an extra
        // await_output round-trip.
        {
            let jobs =
                crate::tools::impls::coding::exec::registry::list_jobs_for_reminder(session_id);
            if !jobs.is_empty() {
                dynamic_sections
                    .push(super::super::background_reminder::build_background_jobs_reminder(&jobs));
                let inlined = super::super::background_reminder::inlined_result_handles(&jobs);
                if !inlined.is_empty() {
                    crate::tools::impls::coding::exec::registry::acknowledge_outputs(&inlined);
                }
            }
        }

        // Todo nag reminder — nudges the model back to `manage_todo` after
        // NAG_THRESHOLD consecutive turns without a todo call, and includes
        // the current list snapshot so the model can act without an extra
        // read call. Injected as a dynamic (non-persisted) section so the
        // user-visible transcript is clean.
        const NAG_THRESHOLD: u32 = 10;
        {
            let rounds = self
                .rounds_since_tool(
                    &self.rounds_since_todo,
                    crate::tools::names::MANAGE_TODO,
                    session_id,
                )
                .await;
            if rounds >= NAG_THRESHOLD {
                let todo_snapshot = tokio::task::block_in_place(|| {
                    crate::persistence::db_helpers::todos::get_todos(session_id).unwrap_or_default()
                });
                dynamic_sections.push(
                    crate::tools::impls::coding::manage_todo::stale_todo_reminder(&todo_snapshot),
                );
                // Reset so the nag re-arms instead of re-firing every turn in
                // a stalled session — the counter now means "rounds since the
                // last todo call OR the last nag", mirroring the reference
                // harness's reminder-to-reminder throttle.
                *self.rounds_since_todo.lock().await = Some(0);
                info!(
                    "[unified_processor] Nag reminder injected ({} turns since last todo call, {} todos attached, session={})",
                    rounds,
                    todo_snapshot.len(),
                    session_id
                );
            }
        }

        // Subagent-delegation reminder — periodically re-surfaces the `agent`
        // tool and its parallel-dispatch guidance (mirrors Claude Code's
        // agent_listing_delta system-reminder; the one-shot mention in the
        // tool schema gets diluted in long sessions). Same cadence pattern
        // as the todo nag above. Skipped for worker sessions: subagents
        // cannot delegate further (see subagent_of_subagent_rejection).
        const SUBAGENT_REMINDER_THRESHOLD: u32 = 10;
        {
            use crate::definitions::prefix_lookup::{
                SHADOW_SUBAGENT_SESSION_PREFIX, SUBAGENT_SESSION_PREFIX,
            };
            let is_worker_session = session_id.starts_with(SUBAGENT_SESSION_PREFIX)
                || session_id.starts_with(SHADOW_SUBAGENT_SESSION_PREFIX);
            let rounds = self
                .rounds_since_tool(
                    &self.rounds_since_subagent_reminder,
                    crate::tools::names::AGENT,
                    session_id,
                )
                .await;
            if !is_worker_session && rounds >= SUBAGENT_REMINDER_THRESHOLD {
                let effective_policy = self.effective_tool_policy();
                let has_agent_tool = self
                    .runtime
                    .tool_registry
                    .prompt_tool_names(effective_policy.as_ref())
                    .iter()
                    .any(|n| n == crate::tools::names::AGENT);
                if has_agent_tool {
                    // Same allowlist source the `agent` tool schema uses —
                    // agent list changes propagate to both surfaces.
                    let allowed: Option<Vec<String>> =
                        if self.runtime.resolved.sub_agents.is_empty() {
                            None
                        } else {
                            Some(
                                self.runtime
                                    .resolved
                                    .sub_agents
                                    .iter()
                                    .map(|s| s.agent_id.clone())
                                    .collect(),
                            )
                        };
                    let ids = crate::tools::impls::orchestration::agent::llm_visible_agent_ids(
                        allowed.as_ref(),
                    );
                    if !ids.is_empty() {
                        dynamic_sections.push(format!(
                            "<system-reminder>Delegation check: for independent research \
                             questions or parallelizable subtasks, use the `agent` tool — \
                             launch multiple workers CONCURRENTLY in a single message \
                             (available: {}). Do not delegate trivial single-lookup \
                             work.</system-reminder>",
                            ids.join(", ")
                        ));
                        *self.rounds_since_subagent_reminder.lock().await = Some(0);
                        info!(
                            "[unified_processor] Subagent reminder injected ({} turns since last, session={})",
                            rounds, session_id
                        );
                    }
                }
            }
        }

        (dynamic_sections, coordinator_presented_work_revision)
    }

    /// Read a lazy transcript-backed reminder counter. `None` (fresh
    /// processor — app restart or session just loaded) rebuilds from the
    /// persisted transcript via `turns_since_last_tool_call` so throttling
    /// state survives restarts; afterwards the in-memory value is the fast
    /// path, maintained by the post-turn increment/reset in `mod.rs`.
    async fn rounds_since_tool(
        &self,
        counter: &tokio::sync::Mutex<Option<u32>>,
        tool_name: &'static str,
        session_id: &str,
    ) -> u32 {
        let mut guard = counter.lock().await;
        if let Some(rounds) = *guard {
            return rounds;
        }
        // Scan cap = 4x threshold: enough tail to prove "recently used",
        // saturates to the cap when the tool is absent (treated as stale).
        const SCAN_LIMIT: u32 = 40;
        let sid = session_id.to_string();
        let rebuilt = tokio::task::block_in_place(|| {
            crate::persistence::db_helpers::turns_since_last_tool_call(&sid, tool_name, SCAN_LIMIT)
                .unwrap_or(0)
        });
        *guard = Some(rebuilt);
        rebuilt
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

#[cfg(test)]
mod linked_work_item_context_tests {
    use super::{
        linked_work_item_context_for_session, render_linked_work_item_context,
        render_orgtrack_cli_brief,
    };

    #[test]
    fn renders_project_scope_without_ambiguous_discovery() {
        let prompt = render_linked_work_item_context("AUTH-0042", Some("auth-core"));

        assert!(prompt.contains("Work Item \"AUTH-0042\""));
        assert!(prompt.contains("--scope auth-core"));
        assert!(!prompt.contains("--standalone"));
        assert!(prompt.contains("instead of creating a duplicate"));
    }

    #[test]
    fn renders_standalone_scope_without_fake_project() {
        let prompt = render_linked_work_item_context("ORG-0042", None);

        assert!(prompt.contains("Work Item \"ORG-0042\""));
        assert!(prompt.contains("`org2-pm work show <id> --standalone`"));
        assert!(prompt.contains("`org2-pm work create --standalone"));
        assert!(!prompt.contains("--scope auth-core"));
        assert!(!prompt.contains("personal-org"));
    }

    #[test]
    fn every_project_session_with_a_link_receives_linked_item_context() {
        let prompt = linked_work_item_context_for_session(Some("project"), Some("WI-0095"), None)
            .expect("linked context");

        assert!(prompt.contains("Work Item \"WI-0095\""));
        assert!(prompt.contains("standalone (no project)"));
        assert!(
            linked_work_item_context_for_session(Some("build"), Some("WI-0095"), None).is_none()
        );
    }

    #[test]
    fn projectless_brief_says_project_is_optional() {
        let prompt =
            render_orgtrack_cli_brief(Some("project"), None).expect("Project-mode CLI brief");

        assert!(prompt.contains("No Project is required"));
        assert!(prompt.contains("route there automatically"));
        assert!(!prompt.contains("Pass --scope"));
    }
}
