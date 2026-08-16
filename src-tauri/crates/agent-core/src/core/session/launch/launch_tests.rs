use super::launch_helpers::{
    apply_member_launch_overrides_to_snapshot, handle_background_launch_failure,
    member_runtime_account_id, member_runtime_key_source, member_runtime_model,
    member_runtime_native_harness_type, validate_launch_agent_definitions,
};
use crate::coordination::agent_org_runs::{
    AgentOrgRunEntryMode, AgentOrgRunStatus, AgentOrgRunStore, CreateAgentOrgRunParams,
    COORDINATOR_MEMBER_ID,
};
use crate::core::session::persistence::{self, UnifiedSessionRecord};
use crate::core::session::SessionStatus;
use crate::definitions::builtin::SDE_AGENT_ID;
use crate::definitions::orgs::{
    FlatOrgMember, OrgDefinition, OrgMemberLaunchOverride, OrgMemberRuntimeConfig,
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

#[test]
fn launch_validation_rejects_missing_agent_definition_before_session_create() {
    let _sandbox = test_helpers::test_env::sandbox();

    let error = validate_launch_agent_definitions(Some("custom:missing-launch-agent"), None)
        .expect_err("missing explicit definition must fail before session creation");

    assert!(error.contains("custom:missing-launch-agent"), "{error}");
    assert!(error.contains("does not exist"), "{error}");
}

fn valid_org_with_members(members: Vec<FlatOrgMember>) -> OrgDefinition {
    OrgDefinition {
        id: "test:member-id-org".to_string(),
        name: "Member Id Org".to_string(),
        role: "Coordinator".to_string(),
        agent_id: SDE_AGENT_ID.to_string(),
        description: None,
        plan_approval_policy: PlanApprovalPolicy::Coordinator,
        members,
        additional_task_graph_writer_member_ids: Vec::new(),
        member_communication_links: Vec::new(),
    }
}

fn ensure_agent_org_launch_test_schemas() {
    let conn = database::db::get_connection().expect("test sqlite connection");
    crate::foundation::persistence::test_schema::ensure_agent_sessions_schema(&conn);
    crate::foundation::persistence::session_snapshots::ensure_tables_with(&conn)
        .expect("agent sessions schema");
    persistence::init(&conn).expect("unified session schema");
    crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org runtime schemas");
}

#[tokio::test]
async fn late_launch_failure_does_not_fail_a_running_team_coordinator() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_agent_org_launch_test_schemas();
    let session_id = "running-team-coordinator";
    persistence::upsert_session(&UnifiedSessionRecord {
        session_id: session_id.to_string(),
        name: "Running Team Coordinator".to_string(),
        status: SessionStatus::Idle.as_str().to_string(),
        session_type: "agent".to_string(),
        agent_definition_id: Some(SDE_AGENT_ID.to_string()),
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        ..Default::default()
    })
    .expect("persist coordinator Session");
    let org = valid_org_with_members(vec![FlatOrgMember {
        member_id: "worker".to_string(),
        name: "Worker".to_string(),
        role: "Builder".to_string(),
        agent_id: SDE_AGENT_ID.to_string(),
        runtime_config: None,
    }]);
    let run = AgentOrgRunStore::create(CreateAgentOrgRunParams {
        org_id: org.id.clone(),
        coordinator_agent_id: org.agent_id.clone(),
        root_session_id: Some(session_id.to_string()),
        org_snapshot: crate::definitions::orgs::AgentOrgLaunchSnapshot::from(&org),
        entry_mode: AgentOrgRunEntryMode::StandaloneSession,
        status: AgentOrgRunStatus::Running,
        work_item_id: None,
        project_slug: None,
        routine_fire_id: None,
    })
    .expect("create Running Team");

    handle_background_launch_failure(
        session_id,
        Some(&run.id),
        None,
        None,
        None,
        "initial dispatch failed after Starting committed",
        "failed to mark Team Starting failure",
        "failed to mark coordinator Session failed",
    )
    .await;

    assert_eq!(
        AgentOrgRunStore::load(&run.id)
            .expect("load Team")
            .expect("Team exists")
            .status,
        AgentOrgRunStatus::Running
    );
    assert_eq!(
        persistence::get_session(session_id)
            .expect("load coordinator Session")
            .expect("coordinator Session exists")
            .status,
        SessionStatus::Idle.as_str()
    );
}

#[test]
fn launch_overrides_apply_to_flat_effective_org_snapshot() {
    let mut org = valid_org_with_members(vec![
        FlatOrgMember {
            member_id: "lead".to_string(),
            name: "Lead".to_string(),
            role: "Lead".to_string(),
            agent_id: SDE_AGENT_ID.to_string(),
            runtime_config: None,
        },
        FlatOrgMember {
            member_id: "child".to_string(),
            name: "Child".to_string(),
            role: "Worker".to_string(),
            agent_id: SDE_AGENT_ID.to_string(),
            runtime_config: None,
        },
    ]);
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

    apply_member_launch_overrides_to_snapshot(&mut org.members, &overrides)
        .expect("override should apply");

    let child = &org.members[1];
    assert_eq!(child.agent_id, "cli:claude_code");
    let runtime_config = child.runtime_config.as_ref().expect("runtime config");
    assert_eq!(runtime_config.account_id.as_deref(), Some("account-child"));
    assert_eq!(runtime_config.model.as_deref(), Some("child-model"));
}

#[test]
fn launch_overrides_reject_unknown_member_ids() {
    let mut org = valid_org_with_members(vec![FlatOrgMember {
        member_id: "lead".to_string(),
        name: "Lead".to_string(),
        role: "Lead".to_string(),
        agent_id: SDE_AGENT_ID.to_string(),
        runtime_config: None,
    }]);
    let mut overrides = HashMap::new();
    overrides.insert(
        "missing".to_string(),
        OrgMemberLaunchOverride {
            agent_id: Some("cli:claude_code".to_string()),
            runtime_config: None,
        },
    );

    let error = apply_member_launch_overrides_to_snapshot(&mut org.members, &overrides)
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
        plan_approval_policy: PlanApprovalPolicy::Coordinator,
        members: vec![FlatOrgMember {
            member_id: "worker".to_string(),
            name: "Worker".to_string(),
            role: "Builder".to_string(),
            agent_id: "custom:deleted-worker".to_string(),
            runtime_config: None,
        }],
        additional_task_graph_writer_member_ids: Vec::new(),
        member_communication_links: Vec::new(),
    };

    let error = validate_launch_agent_definitions(Some(SDE_AGENT_ID), Some(&org))
        .expect_err("missing org member definition must fail before materialization");

    assert!(error.contains("Missing Member Org"), "{error}");
    assert!(error.contains("custom:deleted-worker"), "{error}");
}

#[test]
fn launch_validation_rejects_cli_member_before_run_materialization() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = valid_org_with_members(vec![FlatOrgMember {
        member_id: "cli-worker".to_string(),
        name: "CLI Worker".to_string(),
        role: "Builder".to_string(),
        agent_id: "cli:claude_code".to_string(),
        runtime_config: None,
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
    let org = valid_org_with_members(vec![
        FlatOrgMember {
            member_id: "worker".to_string(),
            name: "Worker A".to_string(),
            role: "Builder".to_string(),
            agent_id: SDE_AGENT_ID.to_string(),
            runtime_config: None,
        },
        FlatOrgMember {
            member_id: "worker".to_string(),
            name: "Worker B".to_string(),
            role: "Reviewer".to_string(),
            agent_id: SDE_AGENT_ID.to_string(),
            runtime_config: None,
        },
    ]);

    let error = validate_launch_agent_definitions(Some(SDE_AGENT_ID), Some(&org))
        .expect_err("duplicate member_id must fail before session creation");

    assert!(error.contains("duplicate member id"), "{error}");
    assert!(error.contains("worker"), "{error}");
}

#[test]
fn launch_validation_rejects_reserved_and_empty_member_ids() {
    let _sandbox = test_helpers::test_env::sandbox();
    for (member_id, expected) in [
        (COORDINATOR_MEMBER_ID, "reserved member id"),
        ("", "empty or reserved member id"),
    ] {
        let org = valid_org_with_members(vec![FlatOrgMember {
            member_id: member_id.to_string(),
            name: "Invalid".to_string(),
            role: "Builder".to_string(),
            agent_id: SDE_AGENT_ID.to_string(),
            runtime_config: None,
        }]);
        let error = validate_launch_agent_definitions(Some(SDE_AGENT_ID), Some(&org))
            .expect_err("invalid member_id values must fail before session creation");
        assert!(error.contains(expected), "{error}");
    }
}
