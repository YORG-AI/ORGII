use super::*;
use std::collections::HashSet;

#[test]
fn ids_are_unique() {
    let mut seen: HashSet<&'static str> = HashSet::new();
    for section in registry() {
        assert!(
            seen.insert(section.id()),
            "duplicate section id: {}",
            section.id()
        );
    }
}

#[test]
fn cache_policy_matrix_matches_conversation_snapshot_audit() {
    for section in registry() {
        let expected = match section.id() {
            "environment"
            | "agent_org_context"
            | "ide_context"
            | "user_profile"
            | "user_presence"
            | "agent_mode_suffix"
            | "flow_awareness"
            | "project_conventions"
            | "mcp_instructions" => PromptCachePolicy::Volatile,
            "learnings" => PromptCachePolicy::RevisionKeyed,
            "identity"
            | "memory_protocol"
            | "system_meta"
            | "model_identity"
            | "available_tools"
            | "behavioral_rules"
            | "rules"
            | "always_skills"
            | "messaging"
            | "silent_replies"
            | "atc"
            | "task_routing"
            | "sub_agent_delegation"
            | "command_approval"
            | "function_result_clearing"
            | "runtime_line" => PromptCachePolicy::StableUntilClear,
            other => panic!(
                "section `{}` is missing from the prompt cache policy audit matrix",
                other
            ),
        };
        assert_eq!(
            section.cache_policy(),
            expected,
            "section `{}` has a cache policy that no longer matches the audited matrix",
            section.id()
        );
    }
}

#[test]
fn registry_is_declared_in_prompt_order() {
    let sections = registry();
    let ids: Vec<&'static str> = sections.iter().map(|section| section.id()).collect();
    assert_eq!(
        ids,
        vec![
            "identity",
            "system_meta",
            "environment",
            "model_identity",
            "available_tools",
            "mcp_instructions",
            "behavioral_rules",
            "project_conventions",
            "rules",
            "always_skills",
            "learnings",
            "memory_protocol",
            "messaging",
            "silent_replies",
            "atc",
            "agent_org_context",
            "task_routing",
            "sub_agent_delegation",
            "command_approval",
            "function_result_clearing",
            "ide_context",
            "user_profile",
            "user_presence",
            "agent_mode_suffix",
            "flow_awareness",
            "runtime_line"
        ]
    );

    for pair in sections.windows(2) {
        let current = pair[0];
        let next = pair[1];
        assert!(
            current.order_hint() < next.order_hint(),
            "registry order drift: `{}` ({}) must be before `{}` ({})",
            current.id(),
            current.order_hint(),
            next.id(),
            next.order_hint()
        );
    }
}

#[test]
fn order_constants_match_registered_sections() {
    let actual: Vec<(&'static str, i32)> = registry()
        .iter()
        .map(|section| (section.id(), section.order_hint()))
        .collect();
    assert_eq!(
        actual,
        vec![
            ("identity", order::IDENTITY),
            ("system_meta", order::SYSTEM_META),
            ("environment", order::ENVIRONMENT),
            ("model_identity", order::MODEL_IDENTITY),
            ("available_tools", order::AVAILABLE_TOOLS),
            ("mcp_instructions", order::MCP_INSTRUCTIONS),
            ("behavioral_rules", order::BEHAVIORAL_RULES),
            ("project_conventions", order::PROJECT_CONVENTIONS),
            ("rules", order::RULES),
            ("always_skills", order::ALWAYS_SKILLS),
            ("learnings", order::LEARNINGS),
            ("memory_protocol", order::MEMORY_PROTOCOL),
            ("messaging", order::MESSAGING),
            ("silent_replies", order::SILENT_REPLIES),
            ("atc", order::ATC),
            ("agent_org_context", order::AGENT_ORG_CONTEXT),
            ("task_routing", order::TASK_ROUTING),
            ("sub_agent_delegation", order::SUB_AGENT_DELEGATION),
            ("command_approval", order::COMMAND_APPROVAL),
            ("function_result_clearing", order::FUNCTION_RESULT_CLEARING),
            ("ide_context", order::IDE_CONTEXT),
            ("user_profile", order::USER_PROFILE),
            ("user_presence", order::USER_PRESENCE),
            ("agent_mode_suffix", order::AGENT_MODE_SUFFIX),
            ("flow_awareness", order::FLOW_AWARENESS),
            ("runtime_line", order::RUNTIME_LINE),
        ]
    );
}

#[test]
fn order_hints_are_unique() {
    // Distinct order hints make the assembled prompt deterministic
    // even if `sort_by_key` is not stable. (`Vec::sort_by_key` IS
    // stable today, so this is a defense-in-depth invariant.)
    let mut seen: HashSet<i32> = HashSet::new();
    for section in registry() {
        assert!(
            seen.insert(section.order_hint()),
            "duplicate order_hint {} on section {}",
            section.order_hint(),
            section.id()
        );
    }
}

#[test]
fn ids_are_snake_case() {
    for section in registry() {
        let id = section.id();
        assert!(!id.is_empty(), "section id is empty");
        assert!(
            id.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
            "section id `{}` is not snake_case",
            id
        );
        assert!(
            !id.starts_with('_') && !id.ends_with('_'),
            "section id `{}` has leading/trailing underscore",
            id
        );
    }
}

// ------------------------------------------------------------------
// Registry-level integration tests — exercise `assemble()` end to end.
//
// These run with the real registry (not a mock) so a regression in
// the policy of any individual section will trip them. The fixtures
// below are deliberately minimal; they prove the *filter / order /
// sovereign* contract, not section content (section content is
// tested in `prompt::sections::tests` and the integration specs).
// ------------------------------------------------------------------

use crate::session::types::SystemPromptConfig;

/// SDE / coding-flow fixture. Builds a `SystemPromptConfig` with
/// `workspace = Some(...)` so workspace-gated sections apply, and
/// no channel set so channel-gated sections skip.
fn sde_config() -> SystemPromptConfig {
    SystemPromptConfig {
        model: "test-model".to_string(),
        agent_id: "test-agent".to_string(),
        agent_definition_id: Some("test-agent-def".to_string()),
        agent_soul: Some("You are test agent.".to_string()),
        load_workspace_resources: true,
        load_workspace_rules: true,
        // Empty workspace path means the conventions / rules
        // loaders gracefully return empty content; we just need
        // `workspace.is_some()` to flip the workspace branch on.
        workspace: Some(crate::session::SessionWorkspace::new(
            std::path::PathBuf::from("/tmp/registry_test_workspace"),
        )),
        ..Default::default()
    }
}

/// Channel / OS-Agent fixture. Sets `channel = Some(...)` so
/// `is_channel_session = true`; no workspace.
fn channel_config() -> SystemPromptConfig {
    SystemPromptConfig {
        model: "test-model".to_string(),
        agent_id: "test-agent".to_string(),
        agent_definition_id: Some("test-agent-def".to_string()),
        agent_soul: Some("You are channel agent.".to_string()),
        channel: Some("telegram".to_string()),
        ..Default::default()
    }
}

/// Sovereign fixture. Same as channel but flips
/// `sovereign_prompt = true` so the registry strips every
/// non-sovereign-safe section.
fn sovereign_config() -> SystemPromptConfig {
    SystemPromptConfig {
        sovereign_prompt: true,
        ..channel_config()
    }
}

/// Collect the section IDs that ended up in the rendered prompt
/// (i.e. `applies && content.is_some()`), in the order they
/// appear. Used to assert ordering and inclusion in one shot.
fn rendered_ids(traces: &[SectionTrace]) -> Vec<&'static str> {
    let mut ids: Vec<(&i32, &'static str)> = traces
        .iter()
        .filter(|t| t.applies && t.content.is_some())
        .map(|t| (&t.order_hint, t.section_id))
        .collect();
    ids.sort_by_key(|(o, _)| *o);
    ids.into_iter().map(|(_, id)| id).collect()
}

#[test]
fn assemble_sde_includes_identity_and_command_approval_excludes_runtime_line() {
    let cfg = sde_config();
    let ctx = PromptCtx::new("sess-sde", &cfg, &[]);
    let (_prompt, traces) = assemble(&ctx);

    let ids = rendered_ids(&traces);
    assert!(ids.contains(&"identity"), "identity should render in SDE");
    assert!(
        ids.contains(&"command_approval"),
        "command_approval should render in SDE (non-channel)"
    );
    // No tools wired ⇒ no `available_tools` row.
    assert!(
        !ids.contains(&"available_tools"),
        "available_tools should skip when no tools are present (got: {:?})",
        ids
    );
    // SDE is not a channel session ⇒ runtime_line skips.
    assert!(
        !ids.contains(&"runtime_line"),
        "runtime_line must skip in SDE (non-channel)"
    );
}

#[test]
fn assemble_channel_includes_runtime_line_excludes_command_approval() {
    let cfg = channel_config();
    let ctx = PromptCtx::new("sess-channel", &cfg, &[]);
    let (_prompt, traces) = assemble(&ctx);

    let ids = rendered_ids(&traces);
    assert!(
        ids.contains(&"runtime_line"),
        "runtime_line should render in channel sessions"
    );
    assert!(
        !ids.contains(&"command_approval"),
        "command_approval must skip in channel sessions"
    );
    // Last rendered section must be runtime_line so the legacy
    // `\n\n---\n\n` separator lands at the very end of the prompt.
    assert_eq!(
        ids.last(),
        Some(&"runtime_line"),
        "runtime_line must be the trailing section in channel sessions (got: {:?})",
        ids
    );
}

#[test]
fn sovereign_filter_strips_non_sovereign_safe_sections() {
    let cfg = sovereign_config();
    let ctx = PromptCtx::new("sess-sovereign", &cfg, &[]);
    let (_prompt, traces) = assemble(&ctx);

    // Every trace must either be sovereign-safe (kept) or carry
    // the canonical `sovereign_filter` skip reason.
    for t in &traces {
        if !t.sovereign_safe {
            assert!(
                !t.applies,
                "non-sovereign-safe section `{}` leaked into a sovereign session",
                t.section_id
            );
            assert_eq!(
                t.reason, "sovereign_filter",
                "non-sovereign-safe section `{}` skipped for the wrong reason: `{}`",
                t.section_id, t.reason
            );
        }
    }

    // Identity, system_meta, rules, learnings and available_tools
    // are the canonical sovereign-safe section set; identity is
    // always-on, the others are conditional but at minimum
    // identity + system_meta must render so the soul is wrapped
    // in the prompt-injection-defense frame.
    let ids = rendered_ids(&traces);
    assert!(
        ids.contains(&"identity"),
        "sovereign session must still render identity"
    );
    assert!(
        ids.contains(&"system_meta"),
        "sovereign session must still render system_meta"
    );
    assert!(
        !ids.contains(&"command_approval"),
        "command_approval must NOT render in a sovereign session"
    );
    assert!(
        !ids.contains(&"runtime_line"),
        "runtime_line must NOT render in a sovereign session"
    );
}

#[test]
fn assemble_with_cache_reuses_stable_section_content() {
    let mut cfg = sde_config();
    cfg.agent_soul = Some("first soul".to_string());
    let mut cache = SessionPromptCache::default();
    {
        let ctx = PromptCtx::new("sess-cache", &cfg, &[]);
        let (prompt, _traces) = assemble_with_cache(&ctx, Some(&mut cache), None);
        assert!(prompt.contains("first soul"));
    }

    cfg.agent_soul = Some("second soul".to_string());
    let ctx = PromptCtx::new("sess-cache", &cfg, &[]);
    let (prompt, _traces) = assemble_with_cache(&ctx, Some(&mut cache), None);
    assert!(prompt.contains("first soul"));
    assert!(!prompt.contains("second soul"));
    assert!(cache.len() > 0);
}

#[test]
fn assemble_with_cache_recomputes_volatile_sections() {
    let mut cfg = sde_config();
    cfg.agent_mode = Some(crate::session::AgentExecMode::Plan);
    let mut cache = SessionPromptCache::default();
    let plan_suffix = {
        let ctx = PromptCtx::new("sess-volatile", &cfg, &[]);
        let (prompt, _traces) = assemble_with_cache(&ctx, Some(&mut cache), None);
        assert!(prompt.contains("Mode: Plan"));
        prompt
    };

    cfg.agent_mode = Some(crate::session::AgentExecMode::Build);
    let ctx = PromptCtx::new("sess-volatile", &cfg, &[]);
    let (build_suffix, _traces) = assemble_with_cache(&ctx, Some(&mut cache), None);
    assert_ne!(plan_suffix, build_suffix);
    assert!(build_suffix.contains("Build Mode"));
}

#[test]
fn project_conventions_reloads_changed_files_between_turns() {
    let workspace = tempfile::tempdir().expect("workspace tempdir");
    let orgii = workspace.path().join(".orgii");
    std::fs::create_dir_all(&orgii).expect("create .orgii");
    let rules = orgii.join("agent-rules.md");
    std::fs::write(&rules, "first marker").expect("write first rules");

    let mut cfg = sde_config();
    cfg.workspace = Some(crate::session::SessionWorkspace::new(
        workspace.path().to_path_buf(),
    ));
    let mut cache = SessionPromptCache::default();

    let first = {
        let ctx = PromptCtx::new("sess-conventions", &cfg, &[]);
        let (prompt, _traces) = assemble_with_cache(&ctx, Some(&mut cache), None);
        prompt
    };
    assert!(first.contains("first marker"));

    std::fs::write(&rules, "second marker").expect("write second rules");
    let ctx = PromptCtx::new("sess-conventions", &cfg, &[]);
    let (second, _traces) = assemble_with_cache(&ctx, Some(&mut cache), None);
    assert!(second.contains("second marker"));
    assert!(!second.contains("first marker"));
}

#[test]
fn assemble_orders_sections_by_order_hint() {
    let cfg = sde_config();
    let ctx = PromptCtx::new("sess-order", &cfg, &[]);
    let (_prompt, traces) = assemble(&ctx);

    let mut prev: Option<i32> = None;
    for t in traces.iter().filter(|t| t.applies && t.content.is_some()) {
        if let Some(p) = prev {
            assert!(
                t.order_hint > p,
                "section `{}` (order {}) appears after order {}, breaking ordering",
                t.section_id,
                t.order_hint,
                p
            );
        }
        prev = Some(t.order_hint);
    }
}

#[test]
fn assembled_prompt_starts_with_identity_section_body() {
    // Byte-level sanity check: identity has the lowest order
    // hint, so its body must lead the assembled prompt. This
    // catches a class of bug where a future contributor adds a
    // new section with `order_hint = 0` and accidentally
    // displaces identity.
    let cfg = sde_config();
    let ctx = PromptCtx::new("sess-prefix", &cfg, &[]);
    let (prompt, _traces) = assemble(&ctx);

    assert!(
        prompt.starts_with("You are test agent."),
        "assembled prompt must lead with the identity body; got prefix: {:?}",
        &prompt[..prompt.len().min(80)]
    );
}
