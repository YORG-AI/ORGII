//! Typed turn assembly for CLI sessions.
//!
//! Keeps the user's visible message separate from provider-only context such
//! as exec-mode, workspace, hook, IDE and prior-conversation bridges. Native
//! transports can route those fields to their system/developer channel while
//! legacy transports retain the historical merged-prompt behavior.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use agent_core::session::{AgentExecMode, IdeContext};
use key_vault::key_store::ModelType;
use sha2::{Digest, Sha256};

use super::context_bridge::build_context_bridge;

type ProviderContextKey = (String, String);
type ProviderContextDigest = [u8; 32];
type DeliveredContextDigests = HashMap<ProviderContextKey, ProviderContextDigest>;

/// Last provider-context digest delivered in this app process. A resumed CLI
/// already has prior turn context, so unchanged rules/skill catalogs do not
/// need to consume tokens again. Process restart and multi-instance use are
/// deliberately independent: each live harness re-delivers once.
static DELIVERED_CONTEXT_DIGESTS: LazyLock<Mutex<DeliveredContextDigests>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// One CLI turn before provider-specific transport encoding.
///
/// `provider_context_prefix` / `provider_context_suffix` preserve the legacy
/// merged prompt's ordering for transports that do not yet expose a native
/// system/developer channel. Native transports consume `user_text` and
/// `provider_context()` independently, so provider context never becomes a
/// visible user message in their native transcript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct CliTurnEnvelope {
    user_text: String,
    provider_context_prefix: Vec<String>,
    provider_context_suffix: Vec<String>,
}

impl CliTurnEnvelope {
    pub(super) fn new(user_text: impl Into<String>) -> Self {
        Self {
            user_text: user_text.into(),
            provider_context_prefix: Vec::new(),
            provider_context_suffix: Vec::new(),
        }
    }

    #[cfg(test)]
    pub(super) fn from_parts(
        user_text: impl Into<String>,
        provider_context: impl Into<String>,
    ) -> Self {
        let mut turn = Self::new(user_text);
        turn.prepend_provider_context(provider_context);
        turn
    }

    pub(super) fn user_text(&self) -> &str {
        &self.user_text
    }

    pub(super) fn prepend_provider_context(&mut self, context: impl Into<String>) {
        let context = context.into();
        if !context.trim().is_empty() {
            self.provider_context_prefix.insert(0, context);
        }
    }

    fn append_provider_context(&mut self, context: impl Into<String>) {
        let context = context.into();
        if !context.trim().is_empty() {
            self.provider_context_suffix.push(context);
        }
    }

    pub(super) fn provider_context(&self) -> Option<String> {
        let context = self
            .provider_context_prefix
            .iter()
            .chain(self.provider_context_suffix.iter())
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join("\n\n");
        (!context.is_empty()).then_some(context)
    }

    /// Compatibility encoding for providers without a native context channel.
    pub(super) fn merged_for_legacy(&self) -> String {
        let mut sections = Vec::with_capacity(
            self.provider_context_prefix.len() + self.provider_context_suffix.len() + 1,
        );
        sections.extend(self.provider_context_prefix.iter().map(String::as_str));
        sections.push(self.user_text.as_str());
        sections.extend(self.provider_context_suffix.iter().map(String::as_str));
        sections.join("\n\n")
    }
}

fn should_deliver_context(
    session_id: &str,
    agent: &ModelType,
    context: &str,
    is_fresh_session: bool,
) -> bool {
    let digest: [u8; 32] = Sha256::digest(context.as_bytes()).into();
    let key = (session_id.to_string(), agent.as_str().to_string());
    let mut delivered = DELIVERED_CONTEXT_DIGESTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !is_fresh_session && delivered.get(&key) == Some(&digest) {
        false
    } else {
        delivered.insert(key, digest);
        true
    }
}

pub(crate) fn forget_session_context(session_id: &str) {
    DELIVERED_CONTEXT_DIGESTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .retain(|(delivered_session_id, _), _| delivered_session_id != session_id);
}

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
            "Before claiming completion, re-read the produced artifact and check every literal acceptance constraint. For a file whose content must be exact, verify byte count and trailing bytes (for example with `wc -c` plus a hex/byte dump); command substitution and trimmed text readers hide trailing newlines and are not proof of byte equality.\n",
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

/// Product-mode overlay for external CLIs. `build` is the provider execution
/// mode; `project` is the separate capability axis that grants the guarded PM
/// CLI surface and durable Work Item contract.
fn project_mode_bridge(
    product_mode: Option<&str>,
    project_slug: Option<&str>,
    work_item_id: Option<&str>,
    status_catalog: Option<&str>,
) -> Option<String> {
    if product_mode != Some("project") {
        return None;
    }
    let status_section = status_catalog
        .map(|catalog| format!("{catalog}\n"))
        .unwrap_or_default();

    let scope = match project_slug {
        Some(slug) => format!(
            "Project scope is injected as ORGII_SCOPE={}; omit --scope unless inspecting another project.",
            slug
        ),
        None => "No Project is required. This session uses the current organization's standalone Work Item scope; omit --scope. Work list/create route there automatically."
            .to_string(),
    };
    let linked_item = match work_item_id {
        Some(id) => format!(
            "This session is linked to Work Item {}. Read it with `org2-pm work show {}` and update that item for refinements; do not create a duplicate root item.",
            id, id
        ),
        None => "The first requested deliverable is the root Work Item. Create it with `org2-pm work create` if bootstrap has not linked one yet."
            .to_string(),
    };

    Some(format!(
        "<orgii_project_mode>\n\
         You are in ORGII Project product mode: Build execution plus the guarded `org2-pm` work-management CLI. Ordinary Build sessions do not have this PM mutation capability.\n\
         Use `org2-pm --help` for discovery and `--output json` for machine-readable results.\n\
         {}\n\
         {}\n\
         Split genuinely independent deliverables into child items. When the requested work is complete, post exactly one outcome receipt with `org2-pm work note <id> --kind progress --body \"...\"`; if blocked, transition the item to blocked and state why. Keep Work Item ids and bookkeeping mechanics out of the user-facing reply.\n\
         Status discipline: state changes go through `org2-pm work transition <id> --to <state>` (`work claim` for in_progress). Use a custom status key from the catalog below when the team defines one that matches the work's stage; never invent a status key.\n\
         Mention discipline: every note notifies the item's subscribers. When a Discussion comment wakes you, answer with ONE reply note (`--parent-id <comment-id>`); never reply to your own notes and never post a note just to acknowledge.\n\
         {}</orgii_project_mode>",
        scope, linked_item, status_section
    ))
}

/// Assemble the visible user turn and its provider-only context.
/// `is_fresh_session` is true when there is no `cli_resume_id` (only a fresh
/// conversation gets the prior-context bridge). `skills_enabled` /
/// `disabled_skills` come from the resolved SDE skills config.
#[allow(clippy::too_many_arguments)]
pub(super) fn build_turn_envelope(
    user_input: &str,
    ide_context: Option<&IdeContext>,
    mode: Option<&str>,
    product_mode: Option<&str>,
    project_slug: Option<&str>,
    work_item_id: Option<&str>,
    session_id: &str,
    is_fresh_session: bool,
    agent: &ModelType,
    image_paths: &[String],
    use_codex_app_server: bool,
    repo_path: Option<&str>,
    skills_enabled: bool,
    disabled_skills: &[String],
    status_catalog: Option<&str>,
) -> CliTurnEnvelope {
    let mut turn = CliTurnEnvelope::new(user_input);

    if let Some(ide_context) = ide_context {
        let context =
            agent_core::core::session::prompt::ide_context::format_ide_context(ide_context);
        if !context.is_empty() {
            turn.prepend_provider_context(format!("<ide_context>\n{}\n</ide_context>", context));
        }
    }

    if let Some(exec_mode_bridge) = cli_exec_mode_bridge(mode) {
        turn.prepend_provider_context(exec_mode_bridge);
    }

    if let Some(project_mode_bridge) =
        project_mode_bridge(product_mode, project_slug, work_item_id, status_catalog)
    {
        turn.prepend_provider_context(project_mode_bridge);
    }

    if is_fresh_session {
        if let Some(context_bridge) = build_context_bridge(session_id) {
            turn.prepend_provider_context(context_bridge);
        }
    }

    if !image_paths.is_empty() && !agent.is_acp() && !use_codex_app_server {
        let refs: Vec<String> = image_paths
            .iter()
            .enumerate()
            .map(|(idx, path)| format!("Image {}: {}", idx + 1, path))
            .collect();
        turn.append_provider_context(format!(
            "IMPORTANT: The user attached {} image(s). You MUST read each image file below before responding. Use your read_file or view_image tool on these absolute paths:\n{}",
            image_paths.len(),
            refs.join("\n"),
        ));
    }

    // Deliver one provider-neutral workspace contract to every CLI, even when
    // that provider also has a native rules file. Native discovery behavior
    // differs across versions and typically understands only one ecosystem
    // filename (for example CLAUDE.md *or* AGENTS.md); the shared envelope
    // guarantees parity across providers. Native context-channel transports
    // re-send the complete current contract on every start/resume because
    // their developer/system override is per launch and may replace the prior
    // override. Legacy merged transports keep the digest gate to avoid paying
    // for unchanged rules on every resumed turn.
    let native_context_channel = matches!(agent, ModelType::ClaudeCode)
        || (matches!(agent, ModelType::Codex) && use_codex_app_server);
    if let Some(path) = repo_path.and_then(|path| {
        let path = std::path::Path::new(path);
        path.is_dir().then_some(path)
    }) {
        if let Some(context) = super::super::skill_sync::build_cli_context_prompt_injection(
            path,
            skills_enabled,
            disabled_skills,
        )
        .filter(|context| {
            native_context_channel
                || should_deliver_context(session_id, agent, context, is_fresh_session)
        }) {
            turn.prepend_provider_context(context);
        }
    }

    // Prompt hooks are dynamic and therefore apply on every turn, including a
    // resumed provider conversation. Command/http lifecycle hooks are fired by
    // the CLI runner itself; only Prompt entries are materialized here.
    let workspace_root = repo_path
        .map(std::path::PathBuf::from)
        .unwrap_or_else(app_paths::orgii_root);
    let hook_executor = agent_core::specialization::hooks::HookExecutor::load_with_workspace_scope(
        &workspace_root,
        repo_path.is_some(),
    );
    if let Some(hook_prompt) = hook_executor
        .collect_prompt_hooks(agent_core::specialization::hooks::HookEvent::PrePromptBuild)
    {
        turn.prepend_provider_context(format!(
            "<orgii_hook_context>\n{}\n</orgii_hook_context>",
            hook_prompt
        ));
    }

    turn
}

#[cfg(test)]
mod tests {
    use super::{build_turn_envelope, project_mode_bridge};
    use agent_core::session::IdeContext;
    use key_vault::key_store::ModelType;

    #[test]
    fn ordinary_build_does_not_receive_pm_cli_guidance() {
        assert!(project_mode_bridge(Some("build"), Some("repo"), Some("WI-1"), None).is_none());
    }

    #[test]
    fn project_is_build_plus_guarded_pm_cli() {
        let bridge = project_mode_bridge(Some("project"), Some("repo"), Some("WI-1"), None)
            .expect("project overlay");
        assert!(bridge.contains("Build execution plus"));
        assert!(bridge.contains("org2-pm work show WI-1"));
        assert!(bridge.contains("ORGII_SCOPE=repo"));
        assert!(bridge.contains("Status discipline"));
        assert!(bridge.contains("Mention discipline"));
        assert!(bridge.ends_with("acknowledge.\n</orgii_project_mode>"));
    }

    #[test]
    fn project_bridge_embeds_the_status_catalog_before_the_closing_tag() {
        let catalog =
            "Custom statuses defined by this organization:\n- completed: `shipped` (Shipped)";
        let bridge =
            project_mode_bridge(Some("project"), Some("repo"), Some("WI-1"), Some(catalog))
                .expect("project overlay");
        assert!(bridge.ends_with(&format!("{catalog}\n</orgii_project_mode>")));
    }

    #[test]
    fn project_without_project_scope_uses_org_level_work_items() {
        let bridge = project_mode_bridge(Some("project"), None, Some("WI-0095"), None)
            .expect("project overlay");
        assert!(bridge.contains("No Project is required"));
        assert!(bridge.contains("route there automatically"));
        assert!(bridge.contains("org2-pm work show WI-0095"));
        assert!(!bridge.contains("Pass --scope"));
    }

    #[test]
    fn every_cli_provider_receives_workspace_context() {
        let workspace = tempfile::tempdir().expect("workspace");
        std::fs::write(
            workspace.path().join("AGENTS.md"),
            "PROVIDER_CONTEXT_SENTINEL",
        )
        .expect("write AGENTS.md");
        let providers = [
            ModelType::CursorCli,
            ModelType::ClaudeCode,
            ModelType::Codex,
            ModelType::Copilot,
            ModelType::Kiro,
            ModelType::KimiCli,
            ModelType::OpenCode,
            ModelType::Aider,
            ModelType::Goose,
            ModelType::Amp,
            ModelType::Cline,
            ModelType::Kilo,
            ModelType::Grok,
            ModelType::Devin,
            ModelType::Rovo,
            ModelType::Hermes,
            ModelType::OpenClaw,
            ModelType::Aug,
            ModelType::Codebuff,
            ModelType::QwenCode,
            ModelType::MimoCode,
            ModelType::Antigravity,
            ModelType::Continue,
            ModelType::Droid,
            ModelType::MistralVibe,
            ModelType::Autohand,
            ModelType::Omp,
            ModelType::Pi,
            ModelType::QoderCli,
            ModelType::TraeCli,
            ModelType::DeepseekHarness,
        ];

        for provider in providers {
            assert!(provider.is_cli_agent());
            let turn = build_turn_envelope(
                "do the task",
                None,
                Some("build"),
                Some("build"),
                None,
                None,
                "session-1",
                true,
                &provider,
                &[],
                false,
                workspace.path().to_str(),
                false,
                &[],
                None,
            );
            let context = turn.provider_context().expect("provider context");
            assert_eq!(turn.user_text(), "do the task");
            assert!(
                context.contains("PROVIDER_CONTEXT_SENTINEL"),
                "{} missed workspace context",
                provider.as_str()
            );
            assert!(
                !context.contains("orgii_project_mode"),
                "{} received Project capabilities in ordinary Build",
                provider.as_str()
            );
        }
    }

    #[test]
    fn unchanged_context_is_delivered_once_and_changes_are_reinjected() {
        let workspace = tempfile::tempdir().expect("workspace");
        let agents_md = workspace.path().join("AGENTS.md");
        std::fs::write(&agents_md, "CONTEXT_V1").expect("write v1");

        let build = || {
            build_turn_envelope(
                "do the task",
                None,
                Some("build"),
                Some("build"),
                None,
                None,
                "digest-session",
                false,
                &ModelType::Codex,
                &[],
                false,
                workspace.path().to_str(),
                false,
                &[],
                None,
            )
        };
        assert!(build()
            .provider_context()
            .is_some_and(|context| context.contains("CONTEXT_V1")));
        assert!(!build()
            .provider_context()
            .is_some_and(|context| context.contains("CONTEXT_V1")));

        std::fs::write(&agents_md, "CONTEXT_V2").expect("write v2");
        assert!(build()
            .provider_context()
            .is_some_and(|context| context.contains("CONTEXT_V2")));
    }

    #[test]
    fn a_fresh_provider_conversation_always_receives_context() {
        let workspace = tempfile::tempdir().expect("workspace");
        std::fs::write(workspace.path().join("AGENTS.md"), "FRESH_CONTEXT").expect("write context");
        let build = |is_fresh_session| {
            build_turn_envelope(
                "do the task",
                None,
                Some("build"),
                Some("build"),
                None,
                None,
                "fresh-session",
                is_fresh_session,
                &ModelType::Codex,
                &[],
                false,
                workspace.path().to_str(),
                false,
                &[],
                None,
            )
        };
        assert!(build(true)
            .provider_context()
            .is_some_and(|context| context.contains("FRESH_CONTEXT")));
        assert!(!build(false)
            .provider_context()
            .is_some_and(|context| context.contains("FRESH_CONTEXT")));
        assert!(build(true)
            .provider_context()
            .is_some_and(|context| context.contains("FRESH_CONTEXT")));
    }

    #[test]
    fn visible_user_text_is_never_polluted_by_agent_context() {
        let ide_context = IdeContext {
            active_file: Some("src/main.rs".to_string()),
            git_branch: Some("feature/native-context".to_string()),
            ..IdeContext::default()
        };
        let turn = build_turn_envelope(
            "Please inspect this exact message.",
            Some(&ide_context),
            Some("build"),
            Some("build"),
            None,
            None,
            "typed-envelope-session",
            false,
            &ModelType::ClaudeCode,
            &[],
            false,
            None,
            false,
            &[],
            None,
        );

        assert_eq!(turn.user_text(), "Please inspect this exact message.");
        let context = turn.provider_context().expect("provider context");
        assert!(context.contains("<orgii_cli_exec_mode_bridge>"));
        assert!(context.contains("<ide_context>"));
        assert!(!turn.user_text().contains("<orgii_"));
        assert!(!turn.user_text().contains("<ide_context>"));
        assert!(turn
            .merged_for_legacy()
            .ends_with("Please inspect this exact message."));
    }

    #[test]
    fn native_context_channels_resend_current_workspace_context_on_resume() {
        let workspace = tempfile::tempdir().expect("workspace");
        std::fs::write(workspace.path().join("AGENTS.md"), "NATIVE_CONTEXT")
            .expect("write context");

        for (agent, use_codex_app_server) in
            [(ModelType::ClaudeCode, false), (ModelType::Codex, true)]
        {
            for _ in 0..2 {
                let turn = build_turn_envelope(
                    "resume",
                    None,
                    Some("build"),
                    Some("build"),
                    None,
                    None,
                    &format!("native-resume-{}", agent.as_str()),
                    false,
                    &agent,
                    &[],
                    use_codex_app_server,
                    workspace.path().to_str(),
                    false,
                    &[],
                    None,
                );
                assert!(turn
                    .provider_context()
                    .is_some_and(|context| context.contains("NATIVE_CONTEXT")));
            }
        }
    }
}
