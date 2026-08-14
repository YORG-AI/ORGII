use super::launch_helpers::{
    apply_member_launch_overrides_to_snapshot, member_runtime_account_id,
    member_runtime_key_source, member_runtime_model, member_runtime_native_harness_type,
    validate_launch_agent_definitions,
};
use crate::coordination::agent_org_runs::{AgentOrgRunRecord, COORDINATOR_MEMBER_ID};
use crate::definitions::builtin::SDE_AGENT_ID;
use crate::definitions::orgs::{
    HierarchyMode, OrgDefinition, OrgMember, OrgMemberLaunchOverride, OrgMemberRuntimeConfig,
    PlanApprovalPolicy,
};
use core_types::key_source::KeySource;
use std::collections::HashMap;

#[test]
fn session_marker_writes_explicit_build_for_legacy_null_product_mode() {
    let workspace = tempfile::tempdir().expect("workspace");
    super::write_agent_session_marker(
        workspace.path().to_str().expect("workspace path"),
        "build-session",
        Some("builtin:sde"),
        None,
        Some("scoped-project"),
        Some("personal-org"),
    );
    let marker =
        std::fs::read_to_string(workspace.path().join(".orgii/agent_session_context.json"))
            .expect("read marker");
    let marker: serde_json::Value = serde_json::from_str(&marker).expect("parse marker");
    assert_eq!(marker["productMode"], "build");
    assert_eq!(marker["scope"], "scoped-project");
    assert_eq!(marker["capabilities"], serde_json::json!(["work.read"]));
}

fn starting_run_updated_at(id: &str, updated_at: &str) -> AgentOrgRunRecord {
    AgentOrgRunRecord {
        id: id.to_string(),
        org_id: "starting-org".to_string(),
        coordinator_agent_id: "agent-coord".to_string(),
        root_session_id: Some(format!("root-{id}")),
        org_snapshot_json: None,
        entry_mode: crate::coordination::agent_org_runs::AgentOrgRunEntryMode::StandaloneSession,
        status: crate::coordination::agent_org_runs::AgentOrgRunStatus::Starting,
        activation_generation: 1,
        has_initial_work: true,
        work_item_id: None,
        project_slug: None,
        routine_fire_id: None,
        summary: None,
        last_error: None,
        failure_json: None,
        last_activity_outcome: None,
        created_at: updated_at.to_string(),
        updated_at: updated_at.to_string(),
        idled_at: None,
    }
}

#[test]
fn watchdog_tick_selects_only_aged_starting_runs_within_the_per_tick_bound() {
    let now = chrono::Utc::now();
    let aged_at =
        (now - chrono::Duration::seconds(super::STARTING_RETRY_GRACE_SECS + 60)).to_rfc3339();
    let young_at = now.to_rfc3339();

    let mut runs = vec![starting_run_updated_at("starting-young", &young_at)];
    for index in 0..(super::STARTING_RETRY_MAX_RUNS_PER_TICK + 3) {
        runs.push(starting_run_updated_at(
            &format!("starting-aged-{index:02}"),
            &aged_at,
        ));
    }
    runs.push(starting_run_updated_at("starting-corrupt-clock", "not-a-timestamp"));

    let selected = super::select_aged_starting_runs(
        runs,
        now,
        super::STARTING_RETRY_GRACE_SECS,
        super::STARTING_RETRY_MAX_RUNS_PER_TICK,
    );

    assert_eq!(
        selected.len(),
        super::STARTING_RETRY_MAX_RUNS_PER_TICK,
        "the tick retry pass is bounded"
    );
    assert!(
        selected.iter().all(|run| run.id != "starting-young"),
        "a Starting run inside the grace window is still owned by its launch task"
    );
    assert!(
        selected.iter().all(|run| run.id.starts_with("starting-aged-")),
        "aged runs feed the tick-driven recovery"
    );

    // The recovery driver is invoked for exactly the selected set: an aged
    // run reaches the per-run routine, a young one never does.
    let two = super::select_aged_starting_runs(
        vec![
            starting_run_updated_at("starting-aged-only", &aged_at),
            starting_run_updated_at("starting-young-only", &young_at),
        ],
        now,
        super::STARTING_RETRY_GRACE_SECS,
        super::STARTING_RETRY_MAX_RUNS_PER_TICK,
    );
    assert_eq!(
        two.iter().map(|run| run.id.as_str()).collect::<Vec<_>>(),
        vec!["starting-aged-only"]
    );
}

#[test]
fn launch_validation_rejects_missing_agent_definition_before_session_create() {
    let _sandbox = test_helpers::test_env::sandbox();

    let error = validate_launch_agent_definitions(Some("custom:missing-launch-agent"), None)
        .expect_err("missing explicit definition must fail before session creation");

    assert!(error.contains("custom:missing-launch-agent"), "{error}");
    assert!(error.contains("does not exist"), "{error}");
}

fn valid_org_with_children(children: Vec<OrgMember>) -> OrgDefinition {
    OrgDefinition {
        id: "test:member-id-org".to_string(),
        name: "Member Id Org".to_string(),
        role: "Coordinator".to_string(),
        agent_id: SDE_AGENT_ID.to_string(),
        description: None,
        hierarchy_mode: HierarchyMode::Soft,
        plan_approval_policy: PlanApprovalPolicy::Coordinator,
        children,
    }
}

#[test]
fn launch_overrides_apply_recursively_to_effective_org_snapshot() {
    let mut org = valid_org_with_children(vec![OrgMember {
        id: "lead".to_string(),
        name: "Lead".to_string(),
        role: "Lead".to_string(),
        agent_id: SDE_AGENT_ID.to_string(),
        runtime_config: None,
        children: vec![OrgMember {
            id: "child".to_string(),
            name: "Child".to_string(),
            role: "Worker".to_string(),
            agent_id: SDE_AGENT_ID.to_string(),
            runtime_config: None,
            children: Vec::new(),
        }],
    }]);
    let mut overrides = HashMap::new();
    overrides.insert(
        "child".to_string(),
        OrgMemberLaunchOverride {
            agent_id: Some("cli:claude_code".to_string()),
            runtime_config: Some(OrgMemberRuntimeConfig {
                key_source: Some("own_key".to_string()),
                account_id: Some("account-child".to_string()),
                model: Some("child-model".to_string()),
                ..Default::default()
            }),
        },
    );

    apply_member_launch_overrides_to_snapshot(&mut org.children, &overrides)
        .expect("override should apply");

    let child = &org.children[0].children[0];
    assert_eq!(child.agent_id, "cli:claude_code");
    let runtime_config = child.runtime_config.as_ref().expect("runtime config");
    assert_eq!(runtime_config.account_id.as_deref(), Some("account-child"));
    assert_eq!(runtime_config.model.as_deref(), Some("child-model"));
}

#[test]
fn launch_overrides_reject_unknown_member_ids() {
    let mut org = valid_org_with_children(vec![OrgMember {
        id: "lead".to_string(),
        name: "Lead".to_string(),
        role: "Lead".to_string(),
        agent_id: SDE_AGENT_ID.to_string(),
        runtime_config: None,
        children: Vec::new(),
    }]);
    let mut overrides = HashMap::new();
    overrides.insert(
        "missing".to_string(),
        OrgMemberLaunchOverride {
            agent_id: Some("cli:claude_code".to_string()),
            runtime_config: None,
        },
    );

    let error = apply_member_launch_overrides_to_snapshot(&mut org.children, &overrides)
        .expect_err("unknown member override must fail");

    assert!(error.contains("missing"), "{error}");
}

#[test]
fn member_runtime_resolution_prefers_member_config_then_falls_back() {
    let fallback_model = Some("fallback-model".to_string());
    let fallback_account = Some("fallback-account".to_string());
    let fallback_harness = Some("cursor_native".to_string());
    let config = OrgMemberRuntimeConfig {
        key_source: Some("hosted_key".to_string()),
        account_id: Some(" member-account ".to_string()),
        model: None,
        listing_model: Some(" listing-model ".to_string()),
        native_harness_type: Some("cursor_native".to_string()),
        tier: Some("premium".to_string()),
        ..Default::default()
    };

    assert_eq!(
        member_runtime_model(Some(&config), &fallback_model).as_deref(),
        Some("listing-model")
    );
    assert_eq!(
        member_runtime_account_id(Some(&config), &fallback_account).as_deref(),
        Some("member-account")
    );
    assert_eq!(
        member_runtime_key_source(Some(&config), &KeySource::OwnKey).expect("key source"),
        KeySource::HostedKey
    );
    assert_eq!(
        member_runtime_native_harness_type(Some(&config), &fallback_harness)
            .expect("native harness")
            .as_deref(),
        Some("cursor_native")
    );
}

#[test]
fn launch_validation_rejects_agent_org_with_missing_member_definition() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = OrgDefinition {
        id: "test:missing-member-org".to_string(),
        name: "Missing Member Org".to_string(),
        role: "Coordinator".to_string(),
        agent_id: SDE_AGENT_ID.to_string(),
        description: None,
        hierarchy_mode: HierarchyMode::Soft,
        plan_approval_policy: PlanApprovalPolicy::Coordinator,
        children: vec![OrgMember {
            id: "worker".to_string(),
            name: "Worker".to_string(),
            role: "Builder".to_string(),
            agent_id: "custom:deleted-worker".to_string(),
            runtime_config: None,
            children: Vec::new(),
        }],
    };

    let error = validate_launch_agent_definitions(Some(SDE_AGENT_ID), Some(&org))
        .expect_err("missing org member definition must fail before materialization");

    assert!(error.contains("Missing Member Org"), "{error}");
    assert!(error.contains("custom:deleted-worker"), "{error}");
}

#[test]
fn launch_validation_rejects_cli_member_before_run_materialization() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = valid_org_with_children(vec![OrgMember {
        id: "cli-worker".to_string(),
        name: "CLI Worker".to_string(),
        role: "Builder".to_string(),
        agent_id: "cli:claude_code".to_string(),
        runtime_config: None,
        children: Vec::new(),
    }]);

    let error = validate_launch_agent_definitions(Some(SDE_AGENT_ID), Some(&org))
        .expect_err("CLI Agent Org members are not production-capable yet");
    assert!(error.contains("cli-worker"), "{error}");
    assert!(error.contains("cli:claude_code"), "{error}");
    assert!(error.contains("inbox"), "{error}");
}

#[test]
fn launch_validation_rejects_duplicate_member_ids() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = valid_org_with_children(vec![
        OrgMember {
            id: "worker".to_string(),
            name: "Worker A".to_string(),
            role: "Builder".to_string(),
            agent_id: SDE_AGENT_ID.to_string(),
            runtime_config: None,
            children: Vec::new(),
        },
        OrgMember {
            id: "worker".to_string(),
            name: "Worker B".to_string(),
            role: "Reviewer".to_string(),
            agent_id: SDE_AGENT_ID.to_string(),
            runtime_config: None,
            children: Vec::new(),
        },
    ]);

    let error = validate_launch_agent_definitions(Some(SDE_AGENT_ID), Some(&org))
        .expect_err("duplicate member_id must fail before session creation");

    assert!(error.contains("duplicate member_id"), "{error}");
    assert!(error.contains("worker"), "{error}");
}

#[test]
fn launch_validation_rejects_reserved_and_empty_member_ids() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = valid_org_with_children(vec![
        OrgMember {
            id: COORDINATOR_MEMBER_ID.to_string(),
            name: "Reserved".to_string(),
            role: "Builder".to_string(),
            agent_id: SDE_AGENT_ID.to_string(),
            runtime_config: None,
            children: Vec::new(),
        },
        OrgMember {
            id: " ".to_string(),
            name: "Blank".to_string(),
            role: "Reviewer".to_string(),
            agent_id: SDE_AGENT_ID.to_string(),
            runtime_config: None,
            children: Vec::new(),
        },
    ]);

    let error = validate_launch_agent_definitions(Some(SDE_AGENT_ID), Some(&org))
        .expect_err("invalid member_id values must fail before session creation");

    assert!(error.contains("reserved id"), "{error}");
    assert!(error.contains("empty id"), "{error}");
}
