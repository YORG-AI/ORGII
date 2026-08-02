use super::launch_helpers::{
    apply_member_launch_overrides_to_snapshot, member_runtime_account_id,
    member_runtime_key_source, member_runtime_model, member_runtime_native_harness_type,
    member_runtime_tier, validate_launch_agent_definitions,
};
use super::{
    launch_rust_agent_run, AgentRunLaunchRequest, AgentRunTarget, LaunchOrgContext,
    LaunchProvenance, LaunchResourceSelection, WorkspaceLaunchTarget,
};
use crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;
use crate::definitions::builtin::SDE_AGENT_ID;
use crate::definitions::orgs::{
    AgentOrgsStore, HierarchyMode, OrgDefinition, OrgMember, OrgMemberLaunchOverride,
    OrgMemberRuntimeConfig, PlanApprovalPolicy,
};
use crate::state::AgentAppState;
use core_types::key_source::KeySource;
use std::collections::HashMap;

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
        member_runtime_tier(Some(&config)).as_deref(),
        Some("premium")
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

#[tokio::test]
async fn launch_validation_rejects_cli_participants_before_session_or_run_creation() {
    let sandbox = test_helpers::test_env::sandbox();
    let conn = database::db::get_connection().expect("test sqlite connection");
    crate::foundation::persistence::test_schema::ensure_agent_sessions_schema(&conn);
    crate::foundation::persistence::session_snapshots::ensure_tables_with(&conn)
        .expect("session snapshot schema");
    crate::session::persistence::init(&conn).expect("unified session schema");
    crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org runtime schemas");

    let store = AgentOrgsStore::new();
    let state = AgentAppState::new();
    for (label, cli_coordinator, expected_participant) in [
        ("coordinator", true, "coordinator"),
        ("worker", false, "cli-worker"),
    ] {
        let children = if cli_coordinator {
            Vec::new()
        } else {
            vec![OrgMember {
                id: "cli-worker".to_string(),
                name: "CLI Worker".to_string(),
                role: "Builder".to_string(),
                agent_id: "cli:claude_code".to_string(),
                runtime_config: None,
                children: Vec::new(),
            }]
        };
        let mut org = valid_org_with_children(children);
        org.id = format!("test:cli-{label}-launch");
        org.name = format!("CLI {label} Launch");
        if cli_coordinator {
            org.agent_id = "cli:claude_code".to_string();
        }
        store
            .seed_for_test(org.clone())
            .expect("seed unsupported CLI participant fixture");

        let count_rows = || -> (i64, i64, i64) {
            conn.query_row(
                "SELECT (SELECT COUNT(*) FROM agent_sessions),
                        (SELECT COUNT(*) FROM agent_org_runs),
                        (SELECT COUNT(*) FROM agent_org_run_sessions)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("count Agent Org persistence rows")
        };
        let before = count_rows();
        let error = launch_rust_agent_run(
            &state,
            Some(&store),
            AgentRunLaunchRequest {
                content: "must reject before materialization".to_string(),
                target: AgentRunTarget::AgentOrg {
                    agent_org_id: org.id,
                    agent_definition_id: None,
                    member_overrides: HashMap::new(),
                    apply_member_overrides_for_future: false,
                },
                resources: LaunchResourceSelection {
                    key_source: None,
                    account_id: None,
                    model: None,
                    native_harness_type: None,
                },
                workspace: WorkspaceLaunchTarget::LocalWorkspace {
                    workspace_path: sandbox.path().to_string_lossy().into_owned(),
                    additional_directories: Vec::new(),
                },
                org_context: LaunchOrgContext {
                    org_id: project_management::projects::types::PERSONAL_ORG_ID.to_string(),
                    project_id: None,
                    project_name: None,
                },
                provenance: LaunchProvenance::UserSession,
                mode: None,
                name: None,
                images: None,
                ide_context: None,
                parent_session_id: None,
                sub_agent_ids: Vec::new(),
            },
        )
        .await
        .expect_err("CLI participant must fail before Root Session and Run creation");

        assert!(error.contains(expected_participant), "{label}: {error}");
        assert!(error.contains("cli:claude_code"), "{label}: {error}");
        assert!(error.contains("inbox"), "{label}: {error}");
        assert!(error.contains("task tools"), "{label}: {error}");
        assert_eq!(count_rows(), before, "{label}: rejected launch mutated DB");
    }
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
