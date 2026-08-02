use super::helpers::load_by_id;
use super::*;
use crate::core::session::persistence::{upsert_session, UnifiedSessionRecord};
use crate::core::session::SessionStatus;
use crate::definitions::orgs::{
    AgentOrgsStore, HierarchyMode, OrgDefinition, OrgMember, PlanApprovalPolicy,
};
use rusqlite::{params, OptionalExtension};

#[test]
fn enum_values_round_trip() {
    assert_eq!(
        AgentOrgRunEntryMode::parse(AgentOrgRunEntryMode::StandaloneSession.as_str()),
        Some(AgentOrgRunEntryMode::StandaloneSession)
    );
    assert_eq!(
        AgentOrgRunStatus::parse(AgentOrgRunStatus::Running.as_str()),
        Some(AgentOrgRunStatus::Running)
    );
    assert_eq!(AgentOrgRunStatus::parse("idle"), None);
}

/// Build an `AgentOrgsStore` pre-loaded with a single org definition.
/// Bypasses the disk loader so tests stay hermetic — the sandbox
/// already isolates `~/.orgii`, but we don't need to touch disk at
/// all to validate the resolver.
fn store_with_org(org: OrgDefinition) -> AgentOrgsStore {
    let store = AgentOrgsStore::default();
    store.orgs.lock().unwrap().push(org);
    store
}

fn sample_org() -> OrgDefinition {
    OrgDefinition {
        id: "org-walk-test".to_string(),
        name: "WalkTest Org".to_string(),
        role: "lead".to_string(),
        agent_id: "agent-coord".to_string(),
        description: None,
        hierarchy_mode: Default::default(),
        plan_approval_policy: PlanApprovalPolicy::Coordinator,
        children: vec![OrgMember {
            id: "member-w1".to_string(),
            name: "Worker One".to_string(),
            role: "ic".to_string(),
            agent_id: "agent-w1".to_string(),
            runtime_config: None,
            children: Vec::new(),
        }],
    }
}

fn ensure_runtime_schemas() {
    let conn = database::db::get_connection().expect("test sqlite connection");
    crate::foundation::persistence::test_schema::ensure_agent_sessions_schema(&conn);
    crate::foundation::persistence::session_snapshots::ensure_tables_with(&conn)
        .expect("agent sessions schema");
    crate::session::persistence::init(&conn).expect("unified session schema");
    crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org runtime schemas");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS code_sessions (
            session_id TEXT PRIMARY KEY,
            cli_agent_type TEXT NOT NULL,
            status TEXT NOT NULL,
            parent_session_id TEXT,
            org_member_id TEXT,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_turn_intents (
            session_id TEXT NOT NULL,
            turn_intent_id TEXT NOT NULL,
            client_message_id TEXT,
            org_run_id TEXT,
            source TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (session_id, turn_intent_id)
        );",
    )
    .expect("cli session schema");
}

fn create_run_for_root(org: &OrgDefinition, root_session_id: &str) -> AgentOrgRunRecord {
    ensure_runtime_schemas();
    AgentOrgRunStore::create(CreateAgentOrgRunParams {
        org_id: org.id.clone(),
        coordinator_agent_id: "agent-coord".to_string(),
        root_session_id: Some(root_session_id.to_string()),
        org_snapshot: org.clone(),
        entry_mode: AgentOrgRunEntryMode::StandaloneSession,
        status: AgentOrgRunStatus::Running,
        work_item_id: None,
        project_slug: None,
        routine_fire_id: None,
    })
    .expect("create run")
}

fn run_params(org: &OrgDefinition, root_session_id: &str) -> CreateAgentOrgRunParams {
    CreateAgentOrgRunParams {
        org_id: org.id.clone(),
        coordinator_agent_id: org.agent_id.clone(),
        root_session_id: Some(root_session_id.to_string()),
        org_snapshot: org.clone(),
        entry_mode: AgentOrgRunEntryMode::StandaloneSession,
        status: AgentOrgRunStatus::Running,
        work_item_id: None,
        project_slug: None,
        routine_fire_id: None,
    }
}

fn set_run_status(run_id: &str, status: &str) {
    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.execute(
        "UPDATE agent_org_runs SET status=?2, updated_at=?3 WHERE id=?1",
        params![run_id, status, chrono::Utc::now().to_rfc3339()],
    )
    .expect("set test run status");
}

#[test]
fn run_constraints_allow_history_but_reject_duplicate_live_and_origin_message() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let root = "root-run-constraints";
    ensure_runtime_schemas();

    let first = AgentOrgRunStore::create_with_lineage(
        run_params(&org, root),
        AgentOrgRunLineage {
            continued_from_run_id: None,
            originating_message_id: Some("message-one".to_string()),
        },
    )
    .expect("create first run");
    assert!(AgentOrgRunStore::create(run_params(&org, root)).is_err());

    let conn = database::db::get_connection().expect("test sqlite connection");
    let starting_result = conn.execute(
        "INSERT INTO agent_org_runs (
            id, org_id, coordinator_agent_id, root_session_id,
            entry_mode, status, created_at, updated_at
         ) VALUES ('starting-duplicate', ?1, ?2, ?3, 'standalone_session',
                   'starting', ?4, ?4)",
        params![
            &org.id,
            &org.agent_id,
            root,
            chrono::Utc::now().to_rfc3339()
        ],
    );
    assert!(starting_result.is_err(), "starting must count as live");

    set_run_status(&first.id, "completed");
    let second = AgentOrgRunStore::create_with_lineage(
        run_params(&org, root),
        AgentOrgRunLineage {
            continued_from_run_id: Some(first.id.clone()),
            originating_message_id: Some("message-two".to_string()),
        },
    )
    .expect("create sequential second run");
    assert_eq!(
        second.continued_from_run_id.as_deref(),
        Some(first.id.as_str())
    );

    set_run_status(&second.id, "completed");
    let duplicate_origin = AgentOrgRunStore::create_with_lineage(
        run_params(&org, root),
        AgentOrgRunLineage {
            continued_from_run_id: Some(second.id.clone()),
            originating_message_id: Some("message-one".to_string()),
        },
    );
    assert!(duplicate_origin.is_err());

    let coordinator_mappings: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_run_sessions
             WHERE session_id=?1 AND role='coordinator'",
            [root],
            |row| row.get(0),
        )
        .expect("count coordinator mappings");
    assert_eq!(coordinator_mappings, 2);
    let sidebar_runs =
        AgentOrgRunStore::list_runs_for_root_session_ids(&[root.to_string()]).unwrap();
    assert_eq!(sidebar_runs.len(), 1);
    assert_eq!(sidebar_runs[0].id, second.id);
    let sidebar_plan = conn
        .prepare(
            "EXPLAIN QUERY PLAN
             WITH requested_roots(root_session_id) AS (VALUES (?1))
             SELECT candidate.id FROM requested_roots requested
             JOIN agent_org_runs candidate ON candidate.id=(
                 SELECT latest.id FROM agent_org_runs latest
                 WHERE latest.root_session_id=requested.root_session_id
                 ORDER BY latest.updated_at DESC, latest.id DESC LIMIT 1
             )",
        )
        .unwrap()
        .query_map([root], |row| row.get::<_, String>(3))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(sidebar_plan
        .iter()
        .any(|detail| detail.contains("idx_agent_org_runs_root_updated")));
    assert!(!sidebar_plan
        .iter()
        .any(|detail| detail.contains("SCAN candidate")));
}

#[test]
fn coordinator_and_rust_worker_creation_are_transactional() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    ensure_runtime_schemas();
    let root_session = UnifiedSessionRecord {
        session_id: "root-atomic-create".to_string(),
        name: "atomic coordinator".to_string(),
        status: SessionStatus::Idle.as_str().to_string(),
        session_type: "agent".to_string(),
        agent_definition_id: Some(org.agent_id.clone()),
        org_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        ..Default::default()
    };
    let run = AgentOrgRunStore::create_with_coordinator_session(
        run_params(&org, &root_session.session_id),
        Default::default(),
        &root_session,
    )
    .expect("atomically create coordinator, run, and mapping");
    assert_eq!(
        AgentOrgRunStore::mapping_for_session(&root_session.session_id)
            .unwrap()
            .len(),
        1
    );

    let worker = UnifiedSessionRecord {
        session_id: "worker-atomic-create".to_string(),
        name: "atomic worker".to_string(),
        status: SessionStatus::Idle.as_str().to_string(),
        session_type: crate::core::session::persistence::session_type::ORG_MEMBER.to_string(),
        agent_definition_id: Some("agent-w1".to_string()),
        org_member_id: Some("member-w1".to_string()),
        parent_session_id: Some(root_session.session_id.clone()),
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        ..Default::default()
    };
    AgentOrgRunStore::materialize_rust_worker_sessions(&run.id, std::slice::from_ref(&worker))
        .expect("atomically create Rust worker and mapping");
    upsert_session(&UnifiedSessionRecord {
        org_member_id: None,
        ..worker.clone()
    })
    .expect("partial upsert preserves mapped member identity");
    let drifted = UnifiedSessionRecord {
        org_member_id: Some("member-w2".to_string()),
        ..worker.clone()
    };
    assert!(upsert_session(&drifted).is_err());
    assert_eq!(
        crate::session::persistence::get_session(&worker.session_id)
            .unwrap()
            .unwrap()
            .org_member_id
            .as_deref(),
        Some("member-w1")
    );
    assert_eq!(
        AgentOrgRunStore::mapping_for_session(&worker.session_id).unwrap()[0].member_id,
        "member-w1"
    );

    let duplicate = UnifiedSessionRecord {
        session_id: "worker-mapping-must-rollback".to_string(),
        ..worker.clone()
    };
    assert!(AgentOrgRunStore::materialize_rust_worker_sessions(&run.id, &[duplicate]).is_err());
    let wrong_agent = UnifiedSessionRecord {
        session_id: "worker-agent-must-match-snapshot".to_string(),
        agent_definition_id: Some("wrong-agent".to_string()),
        ..worker
    };
    assert!(AgentOrgRunStore::materialize_rust_worker_sessions(&run.id, &[wrong_agent]).is_err());
    let conn = database::db::get_connection().expect("test sqlite connection");
    let orphan_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_sessions
             WHERE session_id IN ('worker-mapping-must-rollback',
                                  'worker-agent-must-match-snapshot')",
            [],
            |row| row.get(0),
        )
        .expect("count rolled back worker");
    assert_eq!(orphan_count, 0, "mapping failure must roll back Session");

    set_run_status(&run.id, "completed");
    let coordinator_collision = AgentOrgRunStore::create_with_coordinator_session(
        run_params(&org, "worker-atomic-create"),
        Default::default(),
        &UnifiedSessionRecord {
            session_id: "worker-atomic-create".to_string(),
            name: "must not become coordinator".to_string(),
            status: SessionStatus::Idle.as_str().to_string(),
            session_type: "agent".to_string(),
            agent_definition_id: Some(org.agent_id.clone()),
            org_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
            created_at: chrono::Utc::now().to_rfc3339(),
            updated_at: chrono::Utc::now().to_rfc3339(),
            ..Default::default()
        },
    );
    assert!(coordinator_collision.is_err());
    let collision_runs: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runs
             WHERE root_session_id='worker-atomic-create'",
            [],
            |row| row.get(0),
        )
        .expect("count rolled back coordinator run");
    assert_eq!(collision_runs, 0);
}

#[test]
fn exact_resolver_keeps_old_worker_on_old_run_and_rejects_conflicts() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let store = store_with_org(org.clone());
    let root = "root-resolver-history";
    let first = create_run_for_root(&org, root);
    upsert_session_row(root, None);
    upsert_session_row_for_member(
        "worker-run-one",
        Some(root),
        Some("agent-w1"),
        Some("member-w1"),
        "idle",
    );
    set_run_status(&first.id, "completed");
    let second = AgentOrgRunStore::create_with_lineage(
        run_params(&org, root),
        AgentOrgRunLineage {
            continued_from_run_id: Some(first.id.clone()),
            originating_message_id: Some("resolver-second-message".to_string()),
        },
    )
    .expect("create live second run");

    let unmapped_legacy = UnifiedSessionRecord {
        session_id: "unmapped-worker-from-run-one".to_string(),
        name: "unmapped legacy worker".to_string(),
        status: "idle".to_string(),
        session_type: crate::core::session::persistence::session_type::ORG_MEMBER.to_string(),
        agent_definition_id: Some("agent-w1".to_string()),
        org_member_id: Some("member-w1".to_string()),
        parent_session_id: Some(root.to_string()),
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        ..Default::default()
    };
    upsert_session(&unmapped_legacy).expect("seed unmapped legacy worker");
    let ambiguous_legacy = AgentOrgRunStore::resolve_run_for_session(
        &unmapped_legacy.session_id,
        AgentOrgRunResolution::default(),
        AgentOrgRunResolutionAccess::Mutable,
    )
    .expect_err("unmapped worker must not follow the root's unique live run");
    assert!(ambiguous_legacy.contains("has no exact Run mapping"));
    assert!(AgentOrgRunStore::list_descendant_worker_sessions(&second.id).is_err());
    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.execute(
        "UPDATE agent_sessions SET parent_session_id='worker-run-one'
         WHERE session_id='unmapped-worker-from-run-one'",
        [],
    )
    .expect("move anomaly below an exact-mapped worker");
    assert!(AgentOrgRunStore::resolve_run_for_session(
        &unmapped_legacy.session_id,
        AgentOrgRunResolution::default(),
        AgentOrgRunResolutionAccess::Mutable,
    )
    .is_err());

    let old_worker = AgentOrgRunStore::resolve_run_for_session(
        "worker-run-one",
        AgentOrgRunResolution::default(),
        AgentOrgRunResolutionAccess::Mutable,
    )
    .expect("resolve exact old worker")
    .expect("worker run");
    assert_eq!(old_worker.id, first.id);

    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO session_turn_intents (
            session_id, turn_intent_id, org_run_id, source, status,
            created_at, updated_at
         ) VALUES (?1, 'conflicting-intent', ?2, 'agent_org', 'running', ?3, ?3)",
        params!["worker-run-one", &second.id, &now],
    )
    .expect("seed conflicting active intent");
    let conflict = AgentOrgRunStore::resolve_run_for_session(
        "worker-run-one",
        AgentOrgRunResolution::default(),
        AgentOrgRunResolutionAccess::Mutable,
    )
    .expect_err("intent and mapping disagreement must fail");
    assert!(conflict.contains("ownership conflict"));

    set_run_status(&second.id, "completed");
    conn.execute(
        "UPDATE session_turn_intents SET status='completed'
         WHERE turn_intent_id='conflicting-intent'",
        [],
    )
    .expect("close conflicting intent");
    assert!(AgentOrgRunStore::context_for_session_with_parent_walk(root, &store).is_err());
    let historical = AgentOrgRunStore::context_for_session(
        root,
        &store,
        AgentOrgRunResolution::read_only(Some(first.id.clone())),
        AgentOrgRunResolutionAccess::ReadOnly,
    )
    .expect("explicit historical read")
    .expect("historical context");
    assert_eq!(historical.run_id, first.id);
    assert!(AgentOrgRunStore::context_for_session(
        root,
        &store,
        AgentOrgRunResolution::read_only(Some(first.id)),
        AgentOrgRunResolutionAccess::Mutable,
    )
    .is_err());

    let foreign = create_run_for_root(&org, "foreign-root-resolver");
    conn.execute(
        "INSERT INTO session_turn_intents (
            session_id, turn_intent_id, org_run_id, source, status,
            created_at, updated_at
         ) VALUES (?1, 'cross-root-intent', ?2, 'agent_org', 'running', ?3, ?3)",
        params![root, &foreign.id, chrono::Utc::now().to_rfc3339()],
    )
    .expect("seed cross-root active intent");
    let cross_root = AgentOrgRunStore::resolve_run_for_session(
        root,
        AgentOrgRunResolution::default(),
        AgentOrgRunResolutionAccess::Mutable,
    )
    .expect_err("active turn must not cross Agent Org roots");
    assert!(cross_root.contains("ownership conflict"));
}

#[test]
fn timeline_uses_stable_bounded_keyset_pagination() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let root = "root-timeline-keyset";
    ensure_runtime_schemas();
    let mut ids = Vec::new();
    let mut predecessor = None;
    for index in 0..3 {
        let run = AgentOrgRunStore::create_with_lineage(
            run_params(&org, root),
            AgentOrgRunLineage {
                continued_from_run_id: predecessor.clone(),
                originating_message_id: Some(format!("timeline-message-{index}")),
            },
        )
        .expect("create timeline run");
        set_run_status(&run.id, "completed");
        predecessor = Some(run.id.clone());
        ids.push(run.id);
    }
    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.execute(
        "UPDATE agent_org_runs SET created_at='2026-01-01T00:00:00Z'
         WHERE root_session_id=?1",
        [root],
    )
    .expect("force timestamp ties");

    let first_page = AgentOrgRunStore::list_timeline(root, None, Some(2)).unwrap();
    assert_eq!(first_page.runs.len(), 2);
    assert!(first_page.has_more);
    let second_page =
        AgentOrgRunStore::list_timeline(root, first_page.next_cursor.clone(), Some(2)).unwrap();
    assert_eq!(second_page.runs.len(), 1);
    assert!(!second_page.has_more);
    let paged_ids = first_page
        .runs
        .iter()
        .chain(second_page.runs.iter())
        .map(|run| run.id.clone())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(paged_ids.len(), 3);
    assert_eq!(paged_ids, ids.into_iter().collect());

    let other_root_run = create_run_for_root(&org, "root-timeline-other");
    for index in 3..105 {
        let run = AgentOrgRunStore::create_with_lineage(
            run_params(&org, root),
            AgentOrgRunLineage {
                continued_from_run_id: predecessor.clone(),
                originating_message_id: Some(format!("timeline-message-{index}")),
            },
        )
        .expect("create bounded timeline history");
        set_run_status(&run.id, "completed");
        predecessor = Some(run.id);
    }

    let default_page = AgentOrgRunStore::list_timeline(root, None, None).unwrap();
    assert_eq!(default_page.runs.len(), 50);
    assert!(default_page.has_more);
    assert!(default_page
        .runs
        .iter()
        .all(|run| run.id != other_root_run.id));
    let capped_page = AgentOrgRunStore::list_timeline(root, None, Some(500)).unwrap();
    assert_eq!(capped_page.runs.len(), 100);
    assert!(capped_page.has_more);

    let mut plan_stmt = conn
        .prepare(
            "EXPLAIN QUERY PLAN
             SELECT id FROM agent_org_runs
             WHERE root_session_id=?1
               AND (created_at, id) < (?2, ?3)
             ORDER BY created_at DESC, id DESC LIMIT 50",
        )
        .unwrap();
    let query_plan = plan_stmt
        .query_map(
            params![root, "2026-12-31T23:59:59Z", "timeline-cursor"],
            |row| row.get::<_, String>(3),
        )
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(
        query_plan.iter().any(|detail| {
            detail.contains("idx_agent_org_runs_root_timeline")
                && detail.contains("(created_at,id)<")
        }),
        "cursor query must use a created_at range seek: {query_plan:?}"
    );
}

#[test]
fn migration_backfills_only_unambiguous_rust_and_reports_legacy_cli_boundedly() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let root = "root-migration-backfill";
    let run = create_run_for_root(&org, root);
    let no_snapshot_root = "root-migration-no-snapshot";
    let no_snapshot_run = create_run_for_root(&org, no_snapshot_root);
    let malformed_root = "root-migration-malformed-snapshot";
    let malformed_run = create_run_for_root(&org, malformed_root);
    let contradictory_root = "root-migration-contradictory-snapshot";
    let _contradictory_run = create_run_for_root(&org, contradictory_root);
    upsert_session_row(root, None);
    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.execute(
        "UPDATE agent_org_runs SET org_snapshot_json=NULL WHERE id=?1",
        [&no_snapshot_run.id],
    )
    .unwrap();
    conn.execute(
        "UPDATE agent_org_runs SET org_snapshot_json='{broken' WHERE id=?1",
        [&malformed_run.id],
    )
    .unwrap();
    conn.execute("DELETE FROM agent_org_run_sessions", [])
        .expect("clear mappings for migration fixture");
    for (session_id, parent) in [
        ("ambiguous-worker-a", root),
        ("ambiguous-worker-b", root),
        ("no-snapshot-worker", no_snapshot_root),
        ("malformed-snapshot-worker", malformed_root),
        ("contradictory-snapshot-worker", contradictory_root),
    ] {
        let record = UnifiedSessionRecord {
            session_id: session_id.to_string(),
            name: session_id.to_string(),
            status: "idle".to_string(),
            session_type: crate::core::session::persistence::session_type::ORG_MEMBER.to_string(),
            agent_definition_id: Some(
                if session_id == "contradictory-snapshot-worker" {
                    "agent-other"
                } else {
                    "agent-w1"
                }
                .to_string(),
            ),
            org_member_id: Some("member-w1".to_string()),
            parent_session_id: Some(parent.to_string()),
            created_at: chrono::Utc::now().to_rfc3339(),
            updated_at: chrono::Utc::now().to_rfc3339(),
            ..Default::default()
        };
        upsert_session(&record).expect("seed ambiguous legacy Rust worker");
    }
    conn.execute(
        "INSERT INTO code_sessions (
            session_id, cli_agent_type, status, parent_session_id,
            org_member_id, updated_at
         ) VALUES ('legacy-cli-anomaly', 'claude_code', 'idle', ?1,
                   'member-w1', ?2),
                  (?1, 'claude_code', 'idle', NULL, 'coordinator', ?2)",
        params![root, chrono::Utc::now().to_rfc3339()],
    )
    .expect("seed unsupported legacy CLI anomaly");

    let report = init_schema_with_report(&conn).expect("run idempotent ownership migration");
    assert_eq!(report.coordinator_mappings_backfilled, 4);
    assert_eq!(report.worker_mappings_backfilled, 1);
    assert_eq!(report.ambiguous_worker_sessions, 4);
    assert_eq!(report.unsupported_cli_sessions, 2);
    assert!(report.anomaly_samples.len() <= 20);
    let worker_mappings: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_run_sessions WHERE role='worker'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(worker_mappings, 1);
    assert_eq!(
        AgentOrgRunStore::mapping_for_session("no-snapshot-worker")
            .unwrap()
            .len(),
        1
    );
    assert!(
        AgentOrgRunStore::mapping_for_session("malformed-snapshot-worker")
            .unwrap()
            .is_empty()
    );
    assert!(
        AgentOrgRunStore::mapping_for_session("contradictory-snapshot-worker")
            .unwrap()
            .is_empty()
    );
    assert!(AgentOrgRunStore::mapping_for_session("legacy-cli-anomaly")
        .unwrap()
        .is_empty());
    assert!(load_by_id(&run.id).unwrap().is_some());

    let repeated = init_schema_with_report(&conn).expect("repeat migration safely");
    assert_eq!(repeated.coordinator_mappings_backfilled, 0);
    assert_eq!(repeated.worker_mappings_backfilled, 0);
}

#[test]
fn migration_rejects_duplicate_live_roots_without_partial_mapping_writes() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let root = "root-duplicate-live-migration";
    let first = create_run_for_root(&org, root);
    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.execute("DELETE FROM agent_org_run_sessions", [])
        .expect("clear mappings");
    conn.execute("DROP INDEX idx_agent_org_runs_one_live_per_root", [])
        .expect("simulate pre-constraint database");
    conn.execute(
        "INSERT INTO agent_org_runs (
            id, org_id, coordinator_agent_id, root_session_id,
            entry_mode, status, created_at, updated_at
         ) VALUES ('duplicate-live-run', ?1, ?2, ?3,
                   'standalone_session', 'paused', ?4, ?4)",
        params![
            &org.id,
            &org.agent_id,
            root,
            chrono::Utc::now().to_rfc3339()
        ],
    )
    .expect("seed duplicate live legacy row");

    let error = init_schema_with_report(&conn).expect_err("duplicate live roots must abort");
    assert!(error.to_string().contains("duplicate live Agent Org runs"));
    let mapping_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM agent_org_run_sessions", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(mapping_count, 0);
    let run_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runs WHERE root_session_id=?1",
            [root],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(run_count, 2);
    assert!(load_by_id(&first.id).unwrap().is_some());
}

#[test]
fn delete_by_id_cascades_all_run_owned_state_and_plan_artifact() {
    let sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let run = create_run_for_root(&org, "root-delete-cascade");
    upsert_session_row("root-delete-cascade", None);
    upsert_session_row_for_member(
        "worker-delete-cascade",
        Some("root-delete-cascade"),
        Some("agent-w1"),
        Some("member-w1"),
        "idle",
    );
    crate::coordination::agent_org_tasks::AgentOrgTaskStore::create(
        crate::coordination::agent_org_tasks::CreateTaskParams {
            id: "delete-task".to_string(),
            org_run_id: run.id.clone(),
            subject: "Delete me".to_string(),
            description: String::new(),
            active_form: None,
            owner: Some("member-w1".to_string()),
            status: crate::coordination::agent_org_tasks::TaskStatus::Pending,
            blocks: Vec::new(),
            blocked_by: Vec::new(),
            metadata: None,
        },
    )
    .unwrap();
    crate::coordination::agent_inbox::AgentInboxStore::insert(
        crate::coordination::agent_inbox::InsertInboxParams {
            recipient_agent_id: "agent-w1".to_string(),
            recipient_member_id: Some("member-w1".to_string()),
            sender_agent_id: crate::coordination::agent_inbox::SYSTEM_SENDER_ID.to_string(),
            sender_member_id: None,
            org_run_id: Some(run.id.clone()),
            message: crate::coordination::agent_inbox::AgentMessage::Plain {
                summary: "delete".to_string(),
                text: "delete".to_string(),
            },
        },
    )
    .unwrap();
    crate::coordination::agent_member_interventions::AgentMemberInterventionStore::enter(
        crate::coordination::agent_member_interventions::EnterMemberInterventionParams {
            org_run_id: run.id.clone(),
            member_id: "member-w1".to_string(),
            agent_id: "agent-w1".to_string(),
            session_id: "worker-delete-cascade".to_string(),
            reason: Some("delete".to_string()),
            ttl_secs: 60,
        },
    )
    .unwrap();
    let workspace = sandbox.path().join("delete-workspace");
    let plan_root = workspace.join(".orgii").join("plans");
    std::fs::create_dir_all(&plan_root).expect("create managed Plan root");
    let plan_path = plan_root.join("delete-cascade.plan.md");
    std::fs::write(&plan_path, "# disposable plan").unwrap();
    let external_notes = sandbox.path().join("notes.md");
    std::fs::write(&external_notes, "user-owned notes").unwrap();
    let conn = database::db::get_connection().unwrap();
    conn.execute(
        "UPDATE agent_sessions SET workspace_path=?1 WHERE session_id='worker-delete-cascade'",
        params![workspace.to_string_lossy().as_ref()],
    )
    .expect("attach managed workspace to source session");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_plan_approvals (
            approval_id, plan_revision_id, request_id, org_run_id,
            source_task_id, source_member_id, source_session_id,
            root_session_id, policy, status, plan_title, plan_path,
            plan_content, created_at
         ) VALUES ('delete-approval','delete-revision','delete-request',?1,
                   'delete-task','member-w1','worker-delete-cascade',
                   'root-delete-cascade','coordinator','pending','Delete plan',?2,
                   '# disposable plan',?3)",
        params![&run.id, plan_path.to_string_lossy().as_ref(), &now],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO agent_org_plan_approvals (
            approval_id, plan_revision_id, request_id, org_run_id,
            source_task_id, source_member_id, source_session_id,
            root_session_id, policy, status, plan_title, plan_path,
            plan_content, created_at
         ) VALUES ('external-approval','external-revision','external-request',?1,
                   'delete-task','member-w1','worker-delete-cascade',
                   'root-delete-cascade','coordinator','superseded','Historical notes',?2,
                   '# historical corrupt path',?3)",
        params![&run.id, external_notes.to_string_lossy().as_ref(), &now],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO agent_org_recovery_attempts
         (org_run_id, action_kind, target_key, reason_fingerprint, attempts,
          next_allowed_at, updated_at)
         VALUES (?1,'member_rewake','member-w1','delete',1,?2,?2)",
        params![&run.id, &now],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO agent_org_task_run_schema_migrations
         (name, org_run_id, applied_at)
         VALUES ('delete-test', ?1, ?2)",
        params![&run.id, &now],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO session_turn_intents
         (session_id,turn_intent_id,org_run_id,source,status,created_at,updated_at)
         VALUES ('worker-delete-cascade','delete-intent',?1,'resume','queued',?2,?2)",
        params![&run.id, &now],
    )
    .unwrap();

    AgentOrgRunStore::delete_by_id(&run.id).expect("delete run-owned state");

    for table in [
        "agent_org_run_progress",
        "agent_org_tasks",
        "agent_org_task_events",
        "agent_inbox",
        "agent_member_interventions",
        "agent_org_plan_approvals",
        "agent_org_recovery_attempts",
        "agent_org_task_run_schema_migrations",
    ] {
        let count: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE org_run_id=?1"),
                params![&run.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "{table} retained run-owned rows");
    }
    assert!(load_by_id(&run.id).unwrap().is_none());
    let intent_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_turn_intents
             WHERE turn_intent_id='delete-intent'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(intent_count, 0);
    assert!(!plan_path.exists());
    assert_eq!(
        std::fs::read_to_string(&external_notes).expect("read external notes after deletion"),
        "user-owned notes",
        "run deletion must never remove an unmanaged historical path"
    );
}

#[test]
fn delete_by_id_preserves_nested_run_intents_and_finality_isolation() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let outer = create_run_for_root(&org, "outer-root");
    upsert_session_row_full("outer-root", None, Some("agent-coord"), "idle");
    upsert_session_row_for_member(
        "outer-worker",
        Some("outer-root"),
        Some("agent-w1"),
        Some("member-w1"),
        "idle",
    );

    let nested = create_run_for_root(&org, "nested-root");
    // A nested run root is deliberately also a descendant in the session UI
    // tree. Session ancestry is presentation/navigation state, not ownership.
    upsert_session_row_full(
        "nested-root",
        Some("outer-worker"),
        Some("agent-coord"),
        "idle",
    );
    upsert_session_row_for_member(
        "nested-worker",
        Some("nested-root"),
        Some("agent-w1"),
        Some("member-w1"),
        "running",
    );

    let outer_workers = AgentOrgRunStore::list_descendant_worker_sessions(&outer.id)
        .expect("list only sessions owned by the outer run");
    assert_eq!(outer_workers.len(), 1);
    assert_eq!(outer_workers[0].session_id, "outer-worker");
    assert_eq!(outer_workers[0].status, SessionStatus::Idle);

    let conn = database::db::get_connection().expect("test sqlite connection");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO session_turn_intents
         (session_id,turn_intent_id,org_run_id,source,status,created_at,updated_at)
         VALUES ('outer-worker','outer-wake',?1,'resume','queued',?3,?3),
                ('nested-root','nested-turn',?2,'agent_org','queued',?3,?3)",
        params![&outer.id, &nested.id, &now],
    )
    .expect("seed independently owned intents");

    let outer_assessment =
        AgentOrgRunStore::assess_run_finality(&outer.id).expect("assess outer run finality");
    assert_eq!(
        outer_assessment.facts.in_flight_turn_intent_count, 1,
        "nested run work must not block outer run finality"
    );
    assert_eq!(outer_assessment.facts.worker_sessions.len(), 1);
    assert_eq!(
        outer_assessment.facts.worker_sessions[0].session_id, "outer-worker",
        "a Running worker owned by a nested run must not block outer finality"
    );

    AgentOrgRunStore::delete_by_id(&outer.id).expect("delete outer run");

    assert!(load_by_id(&outer.id).unwrap().is_none());
    assert!(load_by_id(&nested.id).unwrap().is_some());
    let outer_intent_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_turn_intents WHERE org_run_id=?1",
            params![&outer.id],
            |row| row.get(0),
        )
        .expect("count outer intents");
    let nested_intent_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_turn_intents WHERE org_run_id=?1",
            params![&nested.id],
            |row| row.get(0),
        )
        .expect("count nested intents");
    assert_eq!(outer_intent_count, 0);
    assert_eq!(nested_intent_count, 1);
}

#[test]
fn recursive_session_queries_terminate_on_parent_cycle() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let run = create_run_for_root(&org, "cycle-root");
    upsert_session_row_full("cycle-root", Some("cycle-b"), Some("agent-coord"), "idle");
    upsert_session_row_for_member(
        "cycle-a",
        Some("cycle-root"),
        Some("agent-w1"),
        Some("member-w1"),
        "idle",
    );
    upsert_session_row_for_member(
        "cycle-b",
        Some("cycle-a"),
        Some("agent-w2"),
        Some("member-w2"),
        "idle",
    );

    let descendants = AgentOrgRunStore::list_descendant_worker_sessions(&run.id)
        .expect("cyclic descendant scan terminates");
    assert!(
        descendants.len() <= 3,
        "cycle must not duplicate descendants"
    );
    AgentOrgRunStore::assess_run_finality(&run.id).expect("cyclic finality scan terminates");

    let conn = database::db::get_connection().expect("test sqlite connection");
    let now = chrono::Utc::now().to_rfc3339();
    for session_id in ["cycle-root", "cycle-a", "cycle-b"] {
        conn.execute(
            "INSERT INTO session_turn_intents
             (session_id,turn_intent_id,org_run_id,source,status,created_at,updated_at)
             VALUES (?1,?2,?3,'agent_org','queued',?4,?4)",
            params![session_id, format!("intent-{session_id}"), &run.id, &now],
        )
        .expect("seed cyclic session intent");
    }

    AgentOrgRunStore::delete_by_id(&run.id).expect("delete cyclic run");
    let remaining: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_turn_intents
             WHERE session_id IN ('cycle-root','cycle-a','cycle-b')",
            [],
            |row| row.get(0),
        )
        .expect("count cyclic intents");
    assert_eq!(remaining, 0);
}

fn upsert_session_row(session_id: &str, parent_session_id: Option<&str>) {
    upsert_session_row_full(session_id, parent_session_id, None, "running");
}

fn upsert_session_row_full(
    session_id: &str,
    parent_session_id: Option<&str>,
    agent_definition_id: Option<&str>,
    status: &str,
) {
    upsert_session_row_for_member(
        session_id,
        parent_session_id,
        agent_definition_id,
        None,
        status,
    );
}

fn upsert_session_row_for_member(
    session_id: &str,
    parent_session_id: Option<&str>,
    agent_definition_id: Option<&str>,
    org_member_id: Option<&str>,
    status: &str,
) {
    ensure_runtime_schemas();
    let record = UnifiedSessionRecord {
        session_id: session_id.to_string(),
        name: format!("test-{session_id}"),
        status: status.to_string(),
        session_type: if parent_session_id.is_some() {
            crate::core::session::persistence::session_type::ORG_MEMBER.to_string()
        } else {
            "agent".to_string()
        },
        parent_session_id: parent_session_id.map(str::to_string),
        agent_definition_id: agent_definition_id.map(str::to_string),
        org_member_id: org_member_id.map(str::to_string),
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        ..Default::default()
    };
    if agent_definition_id.is_some() && org_member_id.is_some() {
        let parent = parent_session_id.expect("Rust Agent Org worker has a root parent");
        let conn = database::db::get_connection().expect("test sqlite connection");
        let run_id: Option<String> = conn
            .query_row(
                "SELECT id FROM agent_org_runs WHERE root_session_id=?1",
                [parent],
                |row| row.get(0),
            )
            .optional()
            .expect("query owning fixture run");
        if let Some(run_id) = run_id {
            AgentOrgRunStore::materialize_rust_worker_sessions(&run_id, &[record])
                .expect("transactionally materialize Rust worker fixture");
        } else {
            upsert_session(&record).expect("upsert unmapped legacy session row");
        }
    } else {
        upsert_session(&record).expect("upsert session row");
    }
}

fn stamp_coordinator_terminal_turn(session_id: &str) {
    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.execute(
        "UPDATE agent_sessions
         SET last_terminal_turn_at=?2, last_terminal_turn_status='completed'
         WHERE session_id=?1",
        params![session_id, chrono::Utc::now().to_rfc3339()],
    )
    .expect("stamp coordinator terminal turn");
}

fn mark_coordinator_observed_current_work(run_id: &str) {
    let revision = AgentOrgRunStore::stage_coordinator_work_revision(run_id)
        .expect("stage coordinator work revision")
        .expect("running run has a work revision");
    AgentOrgRunStore::mark_coordinator_observed_work_revision(run_id, revision)
        .expect("mark coordinator observed revision");
}

fn upsert_cli_session_row_for_member(
    session_id: &str,
    parent_session_id: &str,
    cli_agent_type: &str,
    org_member_id: &str,
    status: &str,
) {
    ensure_runtime_schemas();
    let now = chrono::Utc::now().to_rfc3339();
    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.execute(
        "INSERT INTO code_sessions (
            session_id,
            cli_agent_type,
            status,
            parent_session_id,
            org_member_id,
            updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(session_id) DO UPDATE SET
            cli_agent_type = excluded.cli_agent_type,
            status = excluded.status,
            parent_session_id = excluded.parent_session_id,
            org_member_id = excluded.org_member_id,
            updated_at = excluded.updated_at",
        params![
            session_id,
            cli_agent_type,
            status,
            parent_session_id,
            org_member_id,
            now
        ],
    )
    .expect("upsert test CLI session");
}

#[test]
fn context_for_session_with_parent_walk_root_session_direct_hit() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let store = store_with_org(org.clone());
    let _run = create_run_for_root(&org, "root-session-1");
    upsert_session_row("root-session-1", None);

    let ctx = AgentOrgRunStore::context_for_session_with_parent_walk("root-session-1", &store)
        .expect("walk ok")
        .expect("context resolved");
    assert_eq!(ctx.coordinator_agent_id, "agent-coord");
    assert_eq!(ctx.members.len(), 1);
    assert_eq!(ctx.members[0].agent_id, "agent-w1");
}

#[test]
fn context_for_run_uses_launch_snapshot_after_live_org_changes() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let store = store_with_org(org.clone());
    let run = create_run_for_root(&org, "root-session-snapshot");
    upsert_session_row("root-session-snapshot", None);

    {
        let mut orgs = store.orgs.lock().expect("org store lock");
        orgs[0].name = "Edited Live Org".to_string();
        orgs[0].role = "edited lead".to_string();
        orgs[0].children[0].id = "member-edited".to_string();
        orgs[0].children[0].agent_id = "agent-edited".to_string();
    }

    let ctx = AgentOrgRunStore::context_for_run(&run.id, &store)
        .expect("context lookup ok")
        .expect("context resolved");
    assert_eq!(ctx.org_name, "WalkTest Org");
    assert_eq!(ctx.coordinator_role, "lead");
    assert_eq!(ctx.members.len(), 1);
    assert_eq!(ctx.members[0].member_id, "member-w1");
    assert_eq!(ctx.members[0].agent_id, "agent-w1");
}

#[test]
fn context_for_session_preserves_org_hierarchy_mode() {
    for hierarchy_mode in [
        HierarchyMode::Flat,
        HierarchyMode::Soft,
        HierarchyMode::Strict,
    ] {
        let _sandbox = test_helpers::test_env::sandbox();
        let mode_label = match hierarchy_mode {
            HierarchyMode::Flat => "flat",
            HierarchyMode::Soft => "soft",
            HierarchyMode::Strict => "strict",
        };
        let mut org = sample_org();
        org.id = format!("org-mode-{mode_label}");
        org.hierarchy_mode = hierarchy_mode;
        let store = store_with_org(org.clone());
        let root_session_id = format!("root-session-{mode_label}");
        let _run = create_run_for_root(&org, &root_session_id);
        upsert_session_row(&root_session_id, None);

        let ctx = AgentOrgRunStore::context_for_session_with_parent_walk(&root_session_id, &store)
            .expect("walk ok")
            .expect("context resolved");
        assert_eq!(ctx.hierarchy_mode, hierarchy_mode);
    }
}

#[test]
fn context_for_session_read_only_allows_unambiguous_legacy_worker() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let store = store_with_org(org.clone());
    let _run = create_run_for_root(&org, "root-session-2");
    upsert_session_row("root-session-2", None);
    upsert_session_row("worker-session-2", Some("root-session-2"));
    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.execute(
        "UPDATE agent_sessions SET agent_definition_id='agent-w1', org_member_id='member-w1'
         WHERE session_id='worker-session-2'",
        [],
    )
    .expect("classify legacy Rust worker without mapping");

    let ctx = AgentOrgRunStore::context_for_session_read_only_with_parent_walk(
        "worker-session-2",
        &store,
    )
    .expect("walk ok")
    .expect("context resolved via parent walk");
    assert_eq!(ctx.run_id, _run.id);
    assert_eq!(ctx.coordinator_agent_id, "agent-coord");
    assert!(
        AgentOrgRunStore::context_for_session_with_parent_walk("worker-session-2", &store).is_err()
    );
}

#[test]
fn context_for_session_does_not_activate_legacy_cli_member_session() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let store = store_with_org(org.clone());
    let _run = create_run_for_root(&org, "root-session-cli-walk");
    upsert_session_row("root-session-cli-walk", None);
    upsert_cli_session_row_for_member(
        "cli-worker-session-walk",
        "root-session-cli-walk",
        "claude_code",
        "member-w1",
        "running",
    );

    let ctx =
        AgentOrgRunStore::context_for_session_with_parent_walk("cli-worker-session-walk", &store)
            .expect("resolver remains diagnostic-safe");
    assert!(ctx.is_none());
}

#[test]
fn context_for_session_with_parent_walk_two_hop_chain() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let store = store_with_org(org.clone());
    let _run = create_run_for_root(&org, "root-session-3");
    upsert_session_row("root-session-3", None);
    upsert_session_row("mid-session-3", Some("root-session-3"));
    upsert_session_row("leaf-session-3", Some("mid-session-3"));

    let ctx = AgentOrgRunStore::context_for_session_with_parent_walk("leaf-session-3", &store)
        .expect("walk ok")
        .expect("context resolved via 2-hop walk");
    assert_eq!(ctx.run_id, _run.id);
}

#[test]
fn context_for_session_with_parent_walk_unrelated_session_returns_none() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let store = store_with_org(org);
    upsert_session_row("orphan-session", None);

    let ctx = AgentOrgRunStore::context_for_session_with_parent_walk("orphan-session", &store)
        .expect("walk ok");
    assert!(
        ctx.is_none(),
        "session with no matching org_run should resolve to None"
    );
}

#[test]
fn context_for_session_with_parent_walk_unknown_session_returns_none() {
    // A `session_id` that doesn't even have a row in `agent_sessions`
    // (e.g. wire from a stale event) should terminate the walk
    // cleanly, not panic and not error.
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let store = store_with_org(org);
    ensure_runtime_schemas();

    let ctx = AgentOrgRunStore::context_for_session_with_parent_walk("ghost-session", &store)
        .expect("walk ok");
    assert!(ctx.is_none());
}

#[test]
fn context_for_session_with_parent_walk_breaks_on_cycle() {
    // Synthetic cycle: A → B → A. Should bail out cleanly with None
    // (and a warn log; we don't assert on logs here).
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let store = store_with_org(org);
    upsert_session_row("cycle-a", Some("cycle-b"));
    upsert_session_row("cycle-b", Some("cycle-a"));

    let ctx = AgentOrgRunStore::context_for_session_with_parent_walk("cycle-a", &store)
        .expect("walk ok despite cycle");
    assert!(
        ctx.is_none(),
        "cyclic parent chain must short-circuit instead of looping forever"
    );
}

#[test]
fn find_worker_session_by_member_id_returns_descendant_with_matching_member_id() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let _store = store_with_org(org.clone());
    let run = create_run_for_root(&org, "coord-root-active");
    upsert_session_row_full("coord-root-active", None, Some("agent-coord"), "running");
    upsert_session_row_for_member(
        "coord-w-active",
        Some("coord-root-active"),
        Some("agent-w1"),
        Some("member-w1"),
        "completed",
    );

    let info = AgentOrgRunStore::find_worker_session_by_member_id(&run.id, "member-w1")
        .expect("query ok")
        .expect("worker found");
    assert_eq!(info.session_id, "coord-w-active");
    assert_eq!(info.status, crate::core::session::SessionStatus::Completed);
}

#[test]
fn find_worker_session_by_member_id_ignores_legacy_cli_member_session() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let _store = store_with_org(org.clone());
    let run = create_run_for_root(&org, "coord-root-cli-active");
    upsert_session_row_full(
        "coord-root-cli-active",
        None,
        Some("agent-coord"),
        "running",
    );
    upsert_cli_session_row_for_member(
        "cli-worker-active",
        "coord-root-cli-active",
        "claude_code",
        "member-w1",
        "running",
    );

    let sessions =
        AgentOrgRunStore::list_worker_sessions_by_member_ids(&run.id, &["member-w1".to_string()])
            .expect("query ok");
    assert!(sessions.is_empty());

    let info =
        AgentOrgRunStore::find_worker_session_by_member_id(&run.id, "member-w1").expect("query ok");
    assert!(info.is_none());
}

#[test]
fn find_worker_session_by_member_id_uses_exact_mapping_not_fresher_unmapped_row() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let _store = store_with_org(org.clone());
    let run = create_run_for_root(&org, "coord-root-rotation");
    upsert_session_row_full("coord-root-rotation", None, Some("agent-coord"), "running");
    upsert_session_row_for_member(
        "coord-w-old",
        Some("coord-root-rotation"),
        Some("agent-w1"),
        Some("member-w1"),
        "completed",
    );
    std::thread::sleep(std::time::Duration::from_millis(2));
    let unmapped = UnifiedSessionRecord {
        session_id: "coord-w-new".to_string(),
        name: "unmapped duplicate".to_string(),
        status: "completed".to_string(),
        session_type: crate::core::session::persistence::session_type::ORG_MEMBER.to_string(),
        parent_session_id: Some("coord-root-rotation".to_string()),
        agent_definition_id: Some("agent-w1".to_string()),
        org_member_id: Some("member-w1".to_string()),
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        ..Default::default()
    };
    upsert_session(&unmapped).expect("seed unmapped legacy duplicate");
    let info = AgentOrgRunStore::find_worker_session_by_member_id(&run.id, "member-w1")
        .expect("query ok")
        .expect("worker found");
    assert_eq!(info.session_id, "coord-w-old");
}

#[test]
fn cross_transport_duplicate_member_uses_fresh_rust_session_and_does_not_block_finality() {
    use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, CreateTaskParams, TaskStatus};

    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let run = create_run_for_root(&org, "coord-root-cross-transport");
    upsert_session_row_full(
        "coord-root-cross-transport",
        None,
        Some("agent-coord"),
        "idle",
    );
    upsert_session_row_for_member(
        "rust-worker-current",
        Some("coord-root-cross-transport"),
        Some("agent-w1"),
        Some("member-w1"),
        "idle",
    );
    upsert_cli_session_row_for_member(
        "cli-worker-stale",
        "coord-root-cross-transport",
        "claude_code",
        "member-w1",
        "running",
    );

    let conn = database::db::get_connection().expect("test sqlite connection");
    let rust_timestamp = "2026-07-17T10:00:01Z";
    let older_cli_timestamp = "2026-07-17T10:00:00Z";
    conn.execute(
        "UPDATE agent_sessions SET updated_at=?1 WHERE session_id='rust-worker-current'",
        params![rust_timestamp],
    )
    .expect("stamp current Rust worker");
    conn.execute(
        "UPDATE code_sessions SET updated_at=?1 WHERE session_id='cli-worker-stale'",
        params![older_cli_timestamp],
    )
    .expect("stamp stale CLI worker");

    let current = AgentOrgRunStore::list_descendant_worker_sessions(&run.id)
        .expect("load current canonical worker");
    assert_eq!(current.len(), 1, "one member must yield one runtime");
    assert_eq!(current[0].session_id, "rust-worker-current");
    assert_eq!(current[0].status, SessionStatus::Idle);
    assert!(current[0].cli_agent_type.is_none());

    conn.execute(
        "UPDATE code_sessions SET updated_at=?1 WHERE session_id='cli-worker-stale'",
        params![rust_timestamp],
    )
    .expect("create exact cross-transport timestamp tie");
    let tied = AgentOrgRunStore::list_descendant_worker_sessions(&run.id)
        .expect("load tie-broken canonical worker");
    assert_eq!(tied.len(), 1);
    assert_eq!(
        tied[0].session_id, "rust-worker-current",
        "Rust is the supported Agent Org transport and must win an exact timestamp tie"
    );
    assert_eq!(tied[0].status, SessionStatus::Idle);

    AgentOrgTaskStore::create(CreateTaskParams {
        id: "cross-transport-done".to_string(),
        org_run_id: run.id.clone(),
        subject: "done".to_string(),
        description: String::new(),
        active_form: None,
        owner: Some("member-w1".to_string()),
        status: TaskStatus::Completed,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: Some(serde_json::json!({
            crate::coordination::agent_org_tasks::TASK_METADATA_ELIGIBLE_MEMBER_IDS:
                ["member-w1"],
        })),
    })
    .expect("create completed task");
    mark_coordinator_observed_current_work(&run.id);
    stamp_coordinator_terminal_turn("coord-root-cross-transport");

    let assessment = AgentOrgRunStore::assess_run_finality(&run.id).expect("assess finality");
    assert_eq!(assessment.facts.worker_sessions.len(), 1);
    assert_eq!(
        assessment.facts.worker_sessions[0].session_id,
        "rust-worker-current"
    );
    assert_eq!(assessment.decision, AgentOrgFinalityDecision::Complete);
    assert_eq!(
        AgentOrgRunStore::reconcile_run_finality(&run.id).expect("reconcile finality"),
        Some(AgentOrgRunStatus::Completed),
        "the stale CLI Running row must not keep the run falsely active"
    );
}

#[test]
fn find_worker_session_by_member_id_returns_none_when_materialized_session_missing() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let _store = store_with_org(org.clone());
    let run = create_run_for_root(&org, "coord-root-no-active");
    upsert_session_row_full("coord-root-no-active", None, Some("agent-coord"), "running");
    let info =
        AgentOrgRunStore::find_worker_session_by_member_id(&run.id, "member-w1").expect("query ok");
    assert!(info.is_none());
}

#[test]
fn find_worker_session_by_member_id_returns_none_for_unknown_run() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_runtime_schemas();
    let info = AgentOrgRunStore::find_worker_session_by_member_id("nope-run", "member-w1")
        .expect("query ok on unknown run");
    assert!(info.is_none());
}

#[test]
fn coordinator_observation_records_only_the_exact_presented_revision() {
    use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, CreateTaskParams, TaskStatus};

    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let run = create_run_for_root(&org, "coord-root-exact-observation");
    let create_task = |id: &str| {
        AgentOrgTaskStore::create(CreateTaskParams {
            id: id.to_string(),
            org_run_id: run.id.clone(),
            subject: id.to_string(),
            description: String::new(),
            active_form: None,
            owner: Some("member-w1".to_string()),
            status: TaskStatus::Pending,
            blocks: Vec::new(),
            blocked_by: Vec::new(),
            metadata: Some(serde_json::json!({
                crate::coordination::agent_org_tasks::TASK_METADATA_ELIGIBLE_MEMBER_IDS:
                    ["member-w1"],
            })),
        })
        .expect("create task");
    };

    create_task("presented-task");
    let presented_revision = AgentOrgRunStore::stage_coordinator_work_revision(&run.id)
        .expect("stage coordinator work revision")
        .expect("running run has a work revision");
    create_task("newer-unseen-task");

    let observed =
        AgentOrgRunStore::mark_coordinator_observed_work_revision(&run.id, presented_revision)
            .expect("record exact observed revision");
    let progress = AgentOrgRunStore::progress(&run.id)
        .expect("load progress")
        .expect("progress exists");

    assert_eq!(observed, Some(presented_revision));
    assert_eq!(
        progress.coordinator_observed_work_revision,
        Some(presented_revision)
    );
    assert!(
        progress.work_revision > presented_revision,
        "a task mutation after prompt staging must remain unobserved"
    );
}

#[test]
fn reconcile_run_finality_completes_run_when_all_tasks_completed() {
    use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, CreateTaskParams, TaskStatus};

    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let run = create_run_for_root(&org, "coord-root-final-complete");
    upsert_session_row_full(
        "coord-root-final-complete",
        None,
        Some("agent-coord"),
        "completed",
    );
    upsert_session(&UnifiedSessionRecord {
        session_id: "worker-final-complete".to_string(),
        name: "worker final complete".to_string(),
        status: crate::core::session::SessionStatus::Completed
            .as_str()
            .to_string(),
        session_type: crate::core::session::persistence::session_type::ORG_MEMBER.to_string(),
        parent_session_id: Some("coord-root-final-complete".to_string()),
        agent_definition_id: Some("agent-w1".to_string()),
        org_member_id: Some("member-w1".to_string()),
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        ..Default::default()
    })
    .expect("upsert completed worker");
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "done-task".to_string(),
        org_run_id: run.id.clone(),
        subject: "done".to_string(),
        description: String::new(),
        active_form: None,
        owner: Some("member-w1".to_string()),
        status: TaskStatus::Completed,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: Some(serde_json::json!({
            crate::coordination::agent_org_tasks::TASK_METADATA_ELIGIBLE_MEMBER_IDS:
                ["member-w1"],
        })),
    })
    .expect("create completed task");
    mark_coordinator_observed_current_work(&run.id);
    stamp_coordinator_terminal_turn("coord-root-final-complete");

    let conn = database::db::get_connection().expect("test sqlite connection");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO session_turn_intents (
             session_id, turn_intent_id, org_run_id, source, status, created_at, updated_at
         ) VALUES (?1, 'final-turn', ?2, 'agent_org', 'optimistic', ?3, ?3)",
        params!["coord-root-final-complete", &run.id, &now],
    )
    .expect("seed pending turn intent");
    for pending_status in ["optimistic", "queued", "running"] {
        conn.execute(
            "UPDATE session_turn_intents SET status=?2 WHERE session_id=?1",
            params!["coord-root-final-complete", pending_status],
        )
        .expect("advance pending turn intent");
        assert_eq!(
            AgentOrgRunStore::reconcile_run_finality(&run.id).expect("reconcile pending intent"),
            Some(AgentOrgRunStatus::Running),
            "a {pending_status} turn intent must keep the run open"
        );
    }
    for terminal_status in [
        "completed",
        "failed",
        "cancelled",
        "stale",
        "coalesced",
        "rejected",
    ] {
        conn.execute(
            "UPDATE session_turn_intents SET status=?2 WHERE session_id=?1",
            params!["coord-root-final-complete", terminal_status],
        )
        .expect("set terminal turn intent");
        assert_eq!(
            AgentOrgRunStore::reconcile_run_finality(&run.id).expect("reconcile terminal intent"),
            Some(AgentOrgRunStatus::Completed),
            "a {terminal_status} turn intent must not keep the run open"
        );
        conn.execute(
            "UPDATE agent_org_runs SET status='running', completed_at=NULL WHERE id=?1",
            params![&run.id],
        )
        .expect("reset run for next terminal status");
    }
    let legacy_resume_after = (chrono::Utc::now() + chrono::Duration::minutes(3)).to_rfc3339();
    conn.execute(
        "INSERT INTO agent_member_interventions (
             org_run_id, member_id, agent_id, session_id, status, reason,
             entered_at, last_user_activity_at, resume_after, cleared_at
         ) VALUES (?1, ?2, 'agent-coord', ?3, 'user_intervention',
                   'direct_user_chat', ?4, ?4, ?5, NULL)",
        params![
            &run.id,
            COORDINATOR_MEMBER_ID,
            "coord-root-final-complete",
            &now,
            &legacy_resume_after,
        ],
    )
    .expect("seed legacy coordinator intervention");

    assert_eq!(
        crate::coordination::agent_member_interventions::AgentMemberInterventionStore::clear_all_active_on_startup()
            .expect("startup intervention cleanup"),
        1
    );
    assert_eq!(
        AgentOrgRunStore::reconcile_resolved_running_runs_on_startup()
            .expect("startup reconcile ok"),
        1
    );
    let reloaded = load_by_id(&run.id).expect("load run").expect("run exists");
    assert_eq!(reloaded.status, AgentOrgRunStatus::Completed);
    assert!(reloaded.completed_at.is_some());
    let legacy_cleared_at: Option<String> = conn
        .query_row(
            "SELECT cleared_at FROM agent_member_interventions
             WHERE org_run_id=?1 AND member_id=?2",
            params![&run.id, COORDINATOR_MEMBER_ID],
            |row| row.get(0),
        )
        .expect("read repaired legacy intervention");
    assert!(legacy_cleared_at.is_some());
}

#[test]
fn reconcile_completes_normal_idle_run_only_after_inbox_is_drained() {
    use crate::coordination::agent_inbox::{
        AgentInboxStore, AgentMessage, InsertInboxParams, SYSTEM_SENDER_ID,
    };
    use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, CreateTaskParams, TaskStatus};

    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let run = create_run_for_root(&org, "coord-root-idle-complete");
    upsert_session_row_full(
        "coord-root-idle-complete",
        None,
        Some("agent-coord"),
        "idle",
    );
    upsert_session(&UnifiedSessionRecord {
        session_id: "worker-idle-complete".to_string(),
        name: "worker idle complete".to_string(),
        status: SessionStatus::Idle.as_str().to_string(),
        session_type: crate::core::session::persistence::session_type::ORG_MEMBER.to_string(),
        parent_session_id: Some("coord-root-idle-complete".to_string()),
        agent_definition_id: Some("agent-w1".to_string()),
        org_member_id: Some("member-w1".to_string()),
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        ..Default::default()
    })
    .unwrap();
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "idle-done".to_string(),
        org_run_id: run.id.clone(),
        subject: "done".to_string(),
        description: String::new(),
        active_form: None,
        owner: Some("member-w1".to_string()),
        status: TaskStatus::Completed,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: None,
    })
    .unwrap();
    mark_coordinator_observed_current_work(&run.id);
    let row = AgentInboxStore::insert(InsertInboxParams {
        recipient_agent_id: "agent-coord".to_string(),
        recipient_member_id: Some(COORDINATOR_MEMBER_ID.to_string()),
        sender_agent_id: SYSTEM_SENDER_ID.to_string(),
        sender_member_id: None,
        org_run_id: Some(run.id.clone()),
        message: AgentMessage::Plain {
            summary: "finalize".to_string(),
            text: "Coordinator still needs to deliver the final result".to_string(),
        },
    })
    .unwrap();
    stamp_coordinator_terminal_turn("coord-root-idle-complete");

    assert_eq!(
        AgentOrgRunStore::reconcile_run_finality(&run.id).unwrap(),
        Some(AgentOrgRunStatus::Running),
        "unread completion facts must be delivered before finality"
    );
    AgentInboxStore::mark_many_read(&[row.id]).unwrap();
    assert_eq!(
        AgentOrgRunStore::reconcile_run_finality(&run.id).unwrap(),
        Some(AgentOrgRunStatus::Completed),
        "normal successful members settle to Idle and must still allow run completion"
    );
}

#[test]
fn resolved_undeliverable_inbox_stays_unread_but_no_longer_blocks_finality() {
    use crate::coordination::agent_inbox::{
        AgentInboxDeliveryResolutionKind, AgentInboxStore, AgentMessage, ResolveInboxDeliveryParams,
    };
    use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, CreateTaskParams, TaskStatus};

    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let run = create_run_for_root(&org, "coord-root-resolved-inbox");
    upsert_session_row_full(
        "coord-root-resolved-inbox",
        None,
        Some("agent-coord"),
        "idle",
    );
    upsert_session_row_for_member(
        "worker-resolved-inbox",
        Some("coord-root-resolved-inbox"),
        Some("agent-w1"),
        Some("member-w1"),
        "idle",
    );
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "resolved-inbox-done".into(),
        org_run_id: run.id.clone(),
        subject: "done".into(),
        description: String::new(),
        active_form: None,
        owner: Some("member-w1".into()),
        status: TaskStatus::Completed,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: None,
    })
    .expect("create completed task");
    mark_coordinator_observed_current_work(&run.id);
    stamp_coordinator_terminal_turn("coord-root-resolved-inbox");

    let message = AgentMessage::Plain {
        summary: "Undeliverable historical row".into(),
        text: "Keep this exact evidence unread".into(),
    };
    let conn = database::db::get_connection().expect("test sqlite connection");
    conn.execute(
        "INSERT INTO agent_inbox (
             recipient_agent_id, recipient_member_id,
             sender_agent_id, sender_member_id, org_run_id,
             payload_kind, payload_json, created_at
         ) VALUES (
             'removed-agent', NULL,
             'agent-coord', 'coordinator', ?1,
             'plain', ?2, ?3
         )",
        params![
            &run.id,
            serde_json::to_string(&message).unwrap(),
            chrono::Utc::now().to_rfc3339(),
        ],
    )
    .expect("seed historical orphan row");
    let inbox_id = conn.last_insert_rowid();

    let before = AgentOrgRunStore::assess_run_finality(&run.id).expect("assess before repair");
    assert_eq!(before.facts.unread_inbox_count, 1);
    assert_eq!(before.decision, AgentOrgFinalityDecision::KeepRunning);

    AgentInboxStore::resolve_delivery(ResolveInboxDeliveryParams {
        inbox_id,
        org_run_id: run.id.clone(),
        resolved_by_member_id: COORDINATOR_MEMBER_ID.into(),
        resolution_kind: AgentInboxDeliveryResolutionKind::Cancelled,
        reason: "Removed recipient and work intentionally abandoned".into(),
        replacement_inbox_id: None,
        replacement_task_id: None,
    })
    .expect("resolve undeliverable delivery");

    let after = AgentOrgRunStore::assess_run_finality(&run.id).expect("assess after repair");
    assert_eq!(after.facts.unread_inbox_count, 0);
    assert_eq!(after.decision, AgentOrgFinalityDecision::Complete);
    assert_eq!(
        AgentOrgRunStore::reconcile_run_finality(&run.id).expect("reconcile repaired run"),
        Some(AgentOrgRunStatus::Completed)
    );
    let evidence = AgentInboxStore::get_by_id_for_run(&run.id, inbox_id)
        .unwrap()
        .unwrap();
    assert!(
        evidence.read_at.is_none(),
        "repair must not forge a read receipt"
    );
}

#[test]
fn startup_reconcile_completes_empty_board_with_explicit_completion_intent() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let run = create_run_for_root(&org, "coord-root-empty-complete");
    upsert_session_row_full(
        "coord-root-empty-complete",
        None,
        Some("agent-coord"),
        "idle",
    );
    mark_coordinator_observed_current_work(&run.id);
    AgentOrgRunStore::request_completion(&run.id, "No durable tasks were required.")
        .expect("record explicit empty-board completion intent");

    assert_eq!(
        AgentOrgRunStore::reconcile_resolved_running_runs_on_startup()
            .expect("startup reconcile empty board"),
        1
    );
    assert_eq!(
        load_by_id(&run.id)
            .expect("load run")
            .expect("run exists")
            .status,
        AgentOrgRunStatus::Completed
    );
}

#[test]
fn reconcile_run_finality_abandons_run_with_open_work_only_after_all_sessions_archived() {
    use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, CreateTaskParams, TaskStatus};

    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let run = create_run_for_root(&org, "coord-root-final-abandoned");
    upsert_session_row_full(
        "coord-root-final-abandoned",
        None,
        Some("agent-coord"),
        "archived",
    );
    upsert_session(&UnifiedSessionRecord {
        session_id: "worker-final-abandoned".to_string(),
        name: "worker final abandoned".to_string(),
        status: crate::core::session::SessionStatus::Archived
            .as_str()
            .to_string(),
        session_type: crate::core::session::persistence::session_type::ORG_MEMBER.to_string(),
        parent_session_id: Some("coord-root-final-abandoned".to_string()),
        agent_definition_id: Some("agent-w1".to_string()),
        org_member_id: Some("member-w1".to_string()),
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        ..Default::default()
    })
    .expect("upsert completed worker");
    for (id, status) in [
        ("done-a", TaskStatus::Completed),
        ("done-b", TaskStatus::Completed),
        ("done-c", TaskStatus::Completed),
        ("done-d", TaskStatus::Completed),
    ] {
        AgentOrgTaskStore::create(CreateTaskParams {
            id: id.to_string(),
            org_run_id: run.id.clone(),
            subject: id.to_string(),
            description: String::new(),
            active_form: None,
            owner: Some("member-w1".to_string()),
            status,
            blocks: Vec::new(),
            blocked_by: Vec::new(),
            metadata: None,
        })
        .expect("create completed task");
    }
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "ownerless-pending".to_string(),
        org_run_id: run.id.clone(),
        subject: "open task".to_string(),
        description: String::new(),
        active_form: None,
        owner: None,
        status: TaskStatus::Pending,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: Some(serde_json::json!({
            crate::coordination::agent_org_tasks::TASK_METADATA_ELIGIBLE_MEMBER_IDS:
                ["member-w1"],
        })),
    })
    .expect("create open task");

    let status = AgentOrgRunStore::reconcile_run_finality(&run.id).expect("reconcile ok");
    assert_eq!(status, Some(AgentOrgRunStatus::Abandoned));
    let reloaded = load_by_id(&run.id).expect("load run").expect("run exists");
    assert_eq!(reloaded.status, AgentOrgRunStatus::Abandoned);
    assert!(reloaded.completed_at.is_some());
}

#[test]
fn failed_or_cancelled_sessions_do_not_abandon_recoverable_open_work() {
    use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, CreateTaskParams, TaskStatus};

    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let run = create_run_for_root(&org, "coord-root-recoverable-failure");
    upsert_session_row_full(
        "coord-root-recoverable-failure",
        None,
        Some("agent-coord"),
        SessionStatus::Failed.as_str(),
    );
    upsert_session_row_for_member(
        "worker-recoverable-failure",
        Some("coord-root-recoverable-failure"),
        Some("agent-w1"),
        Some("member-w1"),
        SessionStatus::Cancelled.as_str(),
    );
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "recoverable-open-task".to_string(),
        org_run_id: run.id.clone(),
        subject: "recoverable".to_string(),
        description: String::new(),
        active_form: None,
        owner: Some("member-w1".to_string()),
        status: TaskStatus::Pending,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: Some(serde_json::json!({
            crate::coordination::agent_org_tasks::TASK_METADATA_ELIGIBLE_MEMBER_IDS:
                ["member-w1"],
        })),
    })
    .expect("create recoverable task");

    assert_eq!(
        AgentOrgRunStore::reconcile_run_finality(&run.id).expect("reconcile"),
        Some(AgentOrgRunStatus::Running)
    );
}

#[test]
fn reconcile_and_task_create_have_one_serializable_outcome() {
    use std::sync::{Arc, Barrier};

    use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, CreateTaskParams, TaskStatus};

    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let run = create_run_for_root(&org, "coord-root-finality-race");
    upsert_session_row_full(
        "coord-root-finality-race",
        None,
        Some("agent-coord"),
        SessionStatus::Completed.as_str(),
    );
    upsert_session(&UnifiedSessionRecord {
        session_id: "worker-finality-race".to_string(),
        name: "worker".to_string(),
        status: SessionStatus::Completed.as_str().to_string(),
        session_type: crate::core::session::persistence::session_type::ORG_MEMBER.to_string(),
        parent_session_id: Some("coord-root-finality-race".to_string()),
        agent_definition_id: Some("agent-w1".to_string()),
        org_member_id: Some("member-w1".to_string()),
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        ..Default::default()
    })
    .unwrap();
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "preexisting-completed".to_string(),
        org_run_id: run.id.clone(),
        subject: "preexisting completed".to_string(),
        description: String::new(),
        active_form: None,
        owner: Some("member-w1".to_string()),
        status: TaskStatus::Completed,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: None,
    })
    .unwrap();
    mark_coordinator_observed_current_work(&run.id);
    stamp_coordinator_terminal_turn("coord-root-finality-race");

    let barrier = Arc::new(Barrier::new(2));
    let reconcile_barrier = Arc::clone(&barrier);
    let reconcile_run_id = run.id.clone();
    let reconcile = std::thread::spawn(move || {
        reconcile_barrier.wait();
        AgentOrgRunStore::reconcile_run_finality(&reconcile_run_id)
    });
    let create_barrier = Arc::clone(&barrier);
    let create_run_id = run.id.clone();
    let create = std::thread::spawn(move || {
        create_barrier.wait();
        AgentOrgTaskStore::create(CreateTaskParams {
            id: "racing-task".to_string(),
            org_run_id: create_run_id,
            subject: "racing task".to_string(),
            description: String::new(),
            active_form: None,
            owner: None,
            status: TaskStatus::Pending,
            blocks: Vec::new(),
            blocked_by: Vec::new(),
            metadata: Some(serde_json::json!({
                crate::coordination::agent_org_tasks::TASK_METADATA_ELIGIBLE_MEMBER_IDS:
                    ["member-w1"],
            })),
        })
    });

    let status = reconcile.join().unwrap().unwrap().unwrap();
    let created = create.join().unwrap();
    match (status, created) {
        (AgentOrgRunStatus::Completed, Err(error)) => {
            assert!(error.contains("agent_org_run_not_mutable"), "got {error}");
        }
        // The create committed first. Reconcile then sees recoverable open
        // work and correctly leaves the Run Running; this is the other valid
        // serial order. Abandoning here would lose a newly-created task.
        (AgentOrgRunStatus::Running, Ok(task)) => assert_eq!(task.id, "racing-task"),
        (status, result) => panic!("non-serializable finality result: {status:?}, {result:?}"),
    }
}

// ── HierarchyMode routing checks ────────────────────────────────
//
// Pure-function coverage for `AgentOrgRunContext::check_routing`.
// The fixture mirrors a real two-branch org so cross-branch hops
// and the coordinator escape hatch can be exercised independently.
//
//     coordinator
//     ├── lead-a (member-a, agent-a)
//     │     └── ic-a   (member-a-ic, agent-a-ic)
//     └── lead-b (member-b, agent-b)
//           └── ic-b   (member-b-ic, agent-b-ic)
fn routing_ctx(mode: HierarchyMode) -> AgentOrgRunContext {
    AgentOrgRunContext {
        run_id: "run-routing".into(),
        org_id: "org-routing".into(),
        org_name: "RoutingOrg".into(),
        org_role: "lead".into(),
        coordinator_agent_id: "agent-coord".into(),
        coordinator_name: "RoutingOrg".into(),
        coordinator_role: "lead".into(),
        members: vec![
            AgentOrgContextMember {
                member_id: "member-a".into(),
                name: "lead-a".into(),
                role: "lead".into(),
                agent_id: "agent-a".into(),
                parent_member_id: None,
            },
            AgentOrgContextMember {
                member_id: "member-a-ic".into(),
                name: "ic-a".into(),
                role: "ic".into(),
                agent_id: "agent-a-ic".into(),
                parent_member_id: Some("member-a".into()),
            },
            AgentOrgContextMember {
                member_id: "member-b".into(),
                name: "lead-b".into(),
                role: "lead".into(),
                agent_id: "agent-b".into(),
                parent_member_id: None,
            },
            AgentOrgContextMember {
                member_id: "member-b-ic".into(),
                name: "ic-b".into(),
                role: "ic".into(),
                agent_id: "agent-b-ic".into(),
                parent_member_id: Some("member-b".into()),
            },
        ],
        hierarchy_mode: mode,
        plan_approval_policy: PlanApprovalPolicy::Coordinator,
        root_session_id: None,
    }
}

#[test]
fn routing_flat_allows_anything() {
    let ctx = routing_ctx(HierarchyMode::Flat);
    assert_eq!(
        ctx.check_routing("member-a-ic", "member-b-ic"),
        RoutingDecision::Allowed,
    );
    assert_eq!(
        ctx.check_routing("member-b", "member-a"),
        RoutingDecision::Allowed,
    );
}

#[test]
fn routing_soft_allows_anything() {
    // Soft mode renders reports-to in the prompt as a hint but
    // never enforces — same outcome as Flat for the runtime layer.
    let ctx = routing_ctx(HierarchyMode::Soft);
    assert_eq!(
        ctx.check_routing("member-a-ic", "member-b-ic"),
        RoutingDecision::Allowed,
    );
}

#[test]
fn task_authority_is_not_peer_message_reachability() {
    let soft = routing_ctx(HierarchyMode::Soft);
    assert_eq!(
        soft.allowed_task_target_member_ids_for("member-a"),
        vec!["member-a".to_string(), "member-a-ic".to_string()]
    );
    assert!(soft.can_assign_task_to("member-a", "member-a-ic"));
    assert!(
        !soft.can_assign_task_to("member-a", "member-b"),
        "Soft permits peer discussion, not peer task assignment"
    );

    let strict = routing_ctx(HierarchyMode::Strict);
    assert!(strict.can_assign_task_to("member-a", "member-a-ic"));
    assert!(!strict.can_assign_task_to("member-a", "member-b"));

    let flat = routing_ctx(HierarchyMode::Flat);
    assert_eq!(
        flat.allowed_task_target_member_ids_for("member-a"),
        vec!["member-a".to_string()],
        "Flat drops reports-to authority for non-coordinator members"
    );
}

#[test]
fn task_authority_coordinator_can_manage_every_participant() {
    let ctx = routing_ctx(HierarchyMode::Strict);
    let allowed = ctx.allowed_task_target_member_ids_for(COORDINATOR_MEMBER_ID);
    assert_eq!(allowed.len(), ctx.members.len() + 1);
    assert!(allowed.contains(&COORDINATOR_MEMBER_ID.to_string()));
    assert!(ctx
        .members
        .iter()
        .all(|member| allowed.contains(&member.member_id)));
}

#[test]
fn routing_strict_allows_send_to_coordinator() {
    let ctx = routing_ctx(HierarchyMode::Strict);
    assert_eq!(
        ctx.check_routing("member-a-ic", COORDINATOR_MEMBER_ID),
        RoutingDecision::Allowed,
        "anyone may escalate to the coordinator",
    );
}

#[test]
fn routing_strict_allows_coordinator_to_anyone() {
    let ctx = routing_ctx(HierarchyMode::Strict);
    assert_eq!(
        ctx.check_routing(COORDINATOR_MEMBER_ID, "member-a-ic"),
        RoutingDecision::Allowed,
        "coordinator escape hatch — may reach any member",
    );
}

#[test]
fn routing_strict_allows_send_to_direct_manager() {
    let ctx = routing_ctx(HierarchyMode::Strict);
    assert_eq!(
        ctx.check_routing("member-a-ic", "member-a"),
        RoutingDecision::Allowed,
    );
}

#[test]
fn routing_strict_allows_send_to_direct_report() {
    let ctx = routing_ctx(HierarchyMode::Strict);
    assert_eq!(
        ctx.check_routing("member-a", "member-a-ic"),
        RoutingDecision::Allowed,
    );
}

#[test]
fn routing_strict_blocks_cross_branch() {
    let ctx = routing_ctx(HierarchyMode::Strict);
    let RoutingDecision::Blocked(hint) = ctx.check_routing("member-a-ic", "member-b-ic") else {
        panic!("expected cross-branch send to be blocked");
    };
    assert!(
        hint.contains("sender_member_id 'member-a-ic'"),
        "hint should name the sender member id (got: {hint})",
    );
    assert!(
        hint.contains("recipient_member_id 'member-b-ic'"),
        "hint should name the recipient member id (got: {hint})",
    );
    assert!(
        hint.contains("Allowed recipient_member_id values: coordinator, member-a"),
        "hint should expose the canonical member-id allow-list (got: {hint})",
    );
}

#[test]
fn routing_strict_blocks_skip_level_up() {
    // ic-a sending to its grand-manager (the coordinator's other
    // direct report) is also a violation — only direct manager is
    // allowed.
    let ctx = routing_ctx(HierarchyMode::Strict);
    assert!(matches!(
        ctx.check_routing("member-a-ic", "member-b"),
        RoutingDecision::Blocked(_)
    ));
}

#[test]
fn routing_strict_blocks_peer_to_peer_lead() {
    let ctx = routing_ctx(HierarchyMode::Strict);
    let RoutingDecision::Blocked(hint) = ctx.check_routing("member-a", "member-b") else {
        panic!("peer leads must not contact each other directly");
    };
    assert!(
        hint.contains("Allowed recipient_member_id values: coordinator"),
        "top-level lead should only be allowed to route through coordinator (got: {hint})",
    );
}

#[test]
fn routing_strict_blocks_unknown_sender_with_useful_hint() {
    // A sender that isn't in the roster (shouldn't happen in
    // practice, but the function must not panic): the message
    // should still surface a Blocked decision rather than silently
    // letting it through.
    let ctx = routing_ctx(HierarchyMode::Strict);
    assert!(matches!(
        ctx.check_routing("member-stranger", "member-a-ic"),
        RoutingDecision::Blocked(_)
    ));
}
