use super::section_builders::{
    build_agent_org_context_section, build_imported_context_section, build_project_environment,
    build_rules_section, cap_rule_content, format_user_profile,
};
use crate::coordination::agent_org_runs::{AgentOrgContextMember, AgentOrgRunContext};
use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, CreateTaskParams, TaskStatus};
use crate::definitions::orgs::HierarchyMode;
use serial_test::serial;
use test_helpers::test_env;

fn prompt_task_sandbox() -> test_env::SandboxGuard {
    let sandbox = test_env::sandbox();
    let conn = database::db::get_connection().expect("test sqlite connection");
    crate::coordination::agent_org_tasks::init_schema(&conn).expect("agent org task schema");
    sandbox
}

#[test]
fn format_user_profile_renders_non_empty_fields() {
    let profile = crate::session::UserProfile {
        tech_savvy: Some("advanced".to_string()),
        job_roles: vec!["Frontend Engineer".to_string(), "Designer".to_string()],
        familiar_tech_stacks: vec!["TypeScript".to_string(), "React".to_string()],
        description: Some("Prefers concise implementation details.".to_string()),
    };

    let rendered = format_user_profile(&profile);

    assert!(rendered.contains("# User Profile"));
    assert!(rendered.contains("Technical familiarity: advanced"));
    assert!(rendered.contains("Job roles: Frontend Engineer, Designer"));
    assert!(rendered.contains("Familiar languages / tech stacks: TypeScript, React"));
    assert!(rendered.contains("About the user: Prefers concise implementation details."));
}

fn prompt_test_agent_org_context() -> AgentOrgRunContext {
    AgentOrgRunContext {
        run_id: "run-prompt-test".to_string(),
        org_id: "org-prompt-test".to_string(),
        org_name: "Prompt Test Org".to_string(),
        org_role: "delivery team".to_string(),
        coordinator_agent_id: "agent-coord".to_string(),
        coordinator_name: "Coordinator".to_string(),
        coordinator_role: "lead".to_string(),
        members: vec![AgentOrgContextMember {
            member_id: "member-worker".to_string(),
            name: "Worker".to_string(),
            role: "implementer".to_string(),
            agent_id: "agent-worker".to_string(),
            parent_member_id: None,
        }],
        hierarchy_mode: HierarchyMode::Flat,
        root_session_id: Some("root-prompt-test".to_string()),
    }
}

#[test]
fn agent_org_prompt_uses_only_runtime_member_id_for_identity() {
    let mut context = prompt_test_agent_org_context();
    context.coordinator_agent_id = "builtin:sde".to_string();
    context.members[0].agent_id = "builtin:sde".to_string();

    let section = build_agent_org_context_section(&context, "builtin:sde", Some("member-worker"));

    assert!(
            section.contains("Your identity in this org:** member_id `member-worker`"),
            "member prompt must use runtime member_id and not infer coordinator from shared agent id: {section}"
        );
    assert!(
        section.contains("- **Member IDs:**"),
        "prompt must list routable members by member_id: {section}"
    );
    assert!(
        !section.contains("using agent `builtin:sde`"),
        "prompt must not expose agent_id as identity/routing guidance: {section}"
    );
}

#[test]
fn agent_org_prompt_uses_task_board_for_roster_delegation() {
    let section =
        build_agent_org_context_section(&prompt_test_agent_org_context(), "agent-coord", None);

    assert!(
        section.contains("Do NOT use the generic `agent` tool to delegate work to roster members"),
        "prompt must prevent the old generic-agent roster path: {section}"
    );
    assert!(
        section.contains("Use `task_create` to add worker-sized subtasks"),
        "prompt must point at production task_create path: {section}"
    );
    assert!(
        section.contains("use `task_update` to reassign"),
        "prompt must point at production task_update path: {section}"
    );
    assert!(
        section.contains("Task assignment wakes idle members"),
        "prompt must describe member-session reaction semantics: {section}"
    );
    assert!(
        !section.contains("delegate worker-sized subtasks with the `agent` tool"),
        "prompt must not preserve stale generic-agent delegation instruction: {section}"
    );
}

#[test]
#[serial]
fn agent_org_prompt_includes_bounded_task_snapshot() {
    let _sandbox = prompt_task_sandbox();
    let context = prompt_test_agent_org_context();
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "prompt-open".to_string(),
        org_run_id: context.run_id.clone(),
        subject: "Open prompt task".to_string(),
        description: String::new(),
        active_form: None,
        owner: Some("member-worker".to_string()),
        status: TaskStatus::InProgress,
        blocks: vec![],
        blocked_by: vec!["prompt-blocker".to_string()],
        metadata: None,
    })
    .unwrap();
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "prompt-done".to_string(),
        org_run_id: context.run_id.clone(),
        subject: "Done prompt task".to_string(),
        description: String::new(),
        active_form: None,
        owner: Some("member-worker".to_string()),
        status: TaskStatus::Completed,
        blocks: vec![],
        blocked_by: vec![],
        metadata: None,
    })
    .unwrap();

    let section = build_agent_org_context_section(&context, "agent-coord", None);
    assert!(section.contains("### Current task board snapshot"));
    assert!(section.contains("`prompt-open` [in_progress] owner=member-worker blocked_by=[prompt-blocker] — Open prompt task"));
    assert!(!section.contains("Done prompt task"));
    assert!(section.contains("Use `task_list` for the full board"));
}

#[test]
#[serial]
fn agent_org_prompt_snapshot_warns_before_duplicate_task_creation() {
    let _sandbox = prompt_task_sandbox();
    let context = prompt_test_agent_org_context();
    let section = build_agent_org_context_section(&context, "agent-coord", None);
    assert!(section.contains("No tasks currently exist on this run."));
    assert!(section.contains("update it instead of creating a duplicate"));
    assert!(section.contains("coordinator must assign an owner explicitly"));
}

#[test]
fn agent_org_prompt_lists_llm_callable_message_kinds() {
    let section =
        build_agent_org_context_section(&prompt_test_agent_org_context(), "agent-coord", None);

    assert!(section.contains("`plain`"), "plain kind missing: {section}");
    assert!(
        section.contains("`shutdown_request` / `shutdown_response`"),
        "shutdown RPC kinds missing: {section}"
    );
    assert!(
        section.contains("`plan_approval_response`"),
        "plan approval response kind missing: {section}"
    );
    assert!(
        section.contains("`exec_mode_set_request`"),
        "exec mode request kind missing: {section}"
    );
}

#[test]
fn agent_org_prompt_explains_member_plan_protocol() {
    let section =
        build_agent_org_context_section(&prompt_test_agent_org_context(), "agent-coord", None);

    assert!(
        section.contains("### Planning workflow"),
        "planning workflow section missing: {section}"
    );
    assert!(
            section.contains("kind = \"exec_mode_set_request\"")
                && section.contains("mode = \"plan\""),
            "coordinator prompt must explain how to set a member to Plan mode before planning: {section}"
        );
    assert!(
        section.contains("Planner-like members should be switched to Plan mode"),
        "coordinator prompt must make Planner-style mode selection explicit: {section}"
    );
    assert!(
        section.contains("kind = \"plan_approval_response\"")
            && section.contains("accepted = true")
            && section.contains("accepted = false"),
        "coordinator prompt must explain approving and rejecting member plans: {section}"
    );
    assert!(
        section.contains("Coordinator or top-level Plan mode is different"),
        "prompt must preserve user-facing coordinator/top-level plan semantics: {section}"
    );
}

#[test]
fn rules_budget_keeps_later_rules_visible() {
    let huge = "a".repeat(60_000);
    let rules = vec![
        ("huge".to_string(), huge),
        ("small".to_string(), "small marker".to_string()),
    ];
    let section = build_rules_section(&rules);
    assert!(section.contains("### huge"));
    assert!(section.contains("### small"));
    assert!(section.contains("small marker"));
    assert!(section.contains("rules budget applied"));
}

#[test]
fn rule_content_truncation_is_utf8_safe() {
    let content = "规则".repeat(30_000);
    let capped = cap_rule_content(&content, 5);
    assert!(capped.is_char_boundary(capped.len()));
    assert!(capped.contains("rule truncated"));
}

#[test]
fn project_env_omits_additional_dirs_when_empty() {
    // negative-half half: sessions that never called
    // `add_workspace_directory` must not emit the block at all,
    // otherwise the prompt cache ping-pongs and every turn
    // pays cold-cache cost.
    let tmp = std::env::temp_dir();
    let out = build_project_environment(&tmp, &[]);
    assert!(
        !out.contains("Additional working directories"),
        "empty additional_dirs must not emit the block: {out}"
    );
}

#[test]
fn project_env_lists_each_additional_dir() {
    // positive-half half: every seeded path must appear in
    // the rendered bullet list. Path literals chosen to be
    // unambiguously test-only so a stray prod match is obvious.
    let tmp = std::env::temp_dir();
    let a = std::path::PathBuf::from("/tmp/pr-f-alpha");
    let b = std::path::PathBuf::from("/tmp/pr-f-beta");
    let dirs: Vec<&std::path::Path> = vec![a.as_path(), b.as_path()];
    let out = build_project_environment(&tmp, &dirs);
    assert!(
        out.contains("- Additional working directories:"),
        "header must be present: {out}"
    );
    assert!(out.contains("/tmp/pr-f-alpha"), "first path missing: {out}");
    assert!(out.contains("/tmp/pr-f-beta"), "second path missing: {out}");
}

#[test]
fn imported_context_section_hydrates_explicit_snippets() {
    let snapshot = crate::session::context_import::ContextSnapshotMeta::new_with_snippet(
        "target-session",
        crate::session::context_import::ContextSourceKind::Session,
        "source-session",
        Some("Source Session".to_string()),
        12,
        true,
        Some("Important decision: imports must be explicit.".to_string()),
    );

    let section = build_imported_context_section(&[snapshot]).expect("section");
    assert!(section.contains("# Imported Context"));
    assert!(section.contains("Source Session"));
    assert!(section.contains("session:source-session"));
    assert!(section.contains("Important decision: imports must be explicit."));
}

#[test]
fn imported_context_section_omits_metadata_only_snapshots() {
    let snapshot = crate::session::context_import::ContextSnapshotMeta::new(
        "target-session",
        crate::session::context_import::ContextSourceKind::Session,
        "source-session",
        Some("Source Session".to_string()),
        12,
        true,
    );

    assert!(build_imported_context_section(&[snapshot]).is_none());
}
