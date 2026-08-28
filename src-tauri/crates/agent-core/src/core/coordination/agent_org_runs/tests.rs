use super::helpers::load_by_id;
use super::*;
use crate::core::session::persistence::{upsert_session, UnifiedSessionRecord};
use crate::core::session::SessionStatus;
use crate::definitions::orgs::{AgentOrgsStore, FlatOrgMember, OrgDefinition, PlanApprovalPolicy};
use rusqlite::params;

fn completed_task_metadata(owner_member_id: &str) -> Option<serde_json::Value> {
    Some(serde_json::json!({
        crate::coordination::agent_org_tasks::TASK_METADATA_ELIGIBLE_MEMBER_IDS:
            [owner_member_id],
        crate::coordination::agent_org_tasks::TASK_METADATA_OUTPUT: {
            "summary": "completed fixture",
            "content": null,
            "artifactIds": [],
            "producedByMemberId": owner_member_id,
            "producedAt": chrono::Utc::now().to_rfc3339(),
        },
    }))
}

#[test]
fn enum_values_round_trip() {
    assert_eq!(
        AgentOrgRunEntryMode::parse(AgentOrgRunEntryMode::StandaloneSession.as_str()),
        Some(AgentOrgRunEntryMode::StandaloneSession)
    );
    for status in [
        AgentOrgRunStatus::Starting,
        AgentOrgRunStatus::Running,
        AgentOrgRunStatus::Paused,
        AgentOrgRunStatus::Idle,
        AgentOrgRunStatus::Failed,
        AgentOrgRunStatus::Archived,
    ] {
        assert_eq!(AgentOrgRunStatus::parse(status.as_str()), Some(status));
    }
    for retired in ["completed", "cancelled", "abandoned", "unknown"] {
        assert_eq!(AgentOrgRunStatus::parse(retired), None);
    }
}

#[test]
fn canonical_schema_snapshot_contains_only_the_long_lived_run_states() {
    let _sandbox = test_helpers::test_env::sandbox();
    ensure_runtime_schemas();
    let conn = database::db::get_connection().expect("test sqlite connection");
    let run_ddl: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master
             WHERE type='table' AND name='agent_org_runtime_runs'",
            [],
            |row| row.get(0),
        )
        .expect("canonical Agent Org run DDL");
    let status_ddl = run_ddl
        .split_once("status TEXT")
        .and_then(|(_, tail)| tail.split_once("activation_generation"))
        .map(|(status_ddl, _)| status_ddl)
        .expect("isolated run-status CHECK");
    for status in [
        "starting", "running", "paused", "idle", "failed", "archived",
    ] {
        assert!(
            status_ddl.contains(&format!("'{status}'")),
            "DDL: {status_ddl}"
        );
    }
    for retired in ["'abandoned'", "'completed'", "'cancelled'"] {
        assert!(!status_ddl.contains(retired), "DDL: {status_ddl}");
    }

    let materialization_ddl: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master
             WHERE type='table' AND name='agent_org_runtime_member_materializations'",
            [],
            |row| row.get(0),
        )
        .expect("canonical materialization receipt DDL");
    assert!(materialization_ddl.contains("PRIMARY KEY(org_run_id, member_id, generation)"));
    assert!(materialization_ddl.contains("UNIQUE(org_run_id, session_id)"));

    let initial_input_ddl: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master
             WHERE type='table' AND name='agent_org_runtime_initial_inputs'",
            [],
            |row| row.get(0),
        )
        .expect("canonical initial-input DDL");
    assert!(initial_input_ddl.contains("UNIQUE(turn_intent_id)"));
    assert!(initial_input_ddl.contains("UNIQUE(message_id)"));
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
        plan_approval_policy: PlanApprovalPolicy::Coordinator,
        members: vec![FlatOrgMember {
            member_id: "member-w1".to_string(),
            name: "Worker One".to_string(),
            role: "ic".to_string(),
            agent_id: "agent-w1".to_string(),
            runtime_config: None,
        }],
        additional_task_graph_writer_member_ids: Vec::new(),
        member_communication_links: Vec::new(),
    }
}

fn test_upsert_turn_intent_with_connection(
    conn: &rusqlite::Connection,
    session_id: &str,
    turn_intent_id: &str,
    client_message_id: Option<&str>,
    org_run_id: Option<&str>,
    source: crate::foundation::session_bridge::TurnIntentBridgeSource,
    status: crate::foundation::session_bridge::TurnIntentBridgeStatus,
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR IGNORE INTO session_turn_intents (
             session_id, turn_intent_id, client_message_id, org_run_id,
             source, status, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![
            session_id,
            turn_intent_id,
            client_message_id,
            org_run_id,
            source.as_str(),
            status.as_str(),
            now,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
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
        );
        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL
        );",
    )
    .expect("cli session schema");
    crate::foundation::session_bridge::register_upsert_turn_intent_with_connection(
        test_upsert_turn_intent_with_connection,
    );
}

fn create_run_for_root(org: &OrgDefinition, root_session_id: &str) -> AgentOrgRunRecord {
    ensure_runtime_schemas();
    AgentOrgRunStore::create(CreateAgentOrgRunParams {
        org_id: org.id.clone(),
        coordinator_agent_id: "agent-coord".to_string(),
        root_session_id: Some(root_session_id.to_string()),
        org_snapshot: org.into(),
        entry_mode: AgentOrgRunEntryMode::StandaloneSession,
        status: AgentOrgRunStatus::Running,
        work_item_id: None,
        project_slug: None,
        routine_fire_id: None,
    })
    .expect("create run")
}

/// Exercise the production two-step protocol used by lifecycle owners: read a
/// pure quiescence certificate, then present its exact generation and work
/// revision to the atomic CAS transition.  Keeping this helper in tests makes
/// old completion scenarios validate the new protocol instead of recreating the
/// removed one-shot reconciler.
fn reconcile_run_to_idle_for_test(run_id: &str) -> Result<AgentOrgRunStatus, String> {
    let assessment = AgentOrgRunStore::assess_run_quiescence(run_id)?;
    if assessment.decision == AgentOrgQuiescenceDecision::Quiescent {
        let generation = assessment
            .facts
            .activation_generation
            .ok_or_else(|| "missing activation generation".to_string())?;
        let work_revision = assessment
            .facts
            .progress
            .as_ref()
            .map(|progress| progress.work_revision)
            .ok_or_else(|| "missing work revision".to_string())?;
        AgentOrgRunStore::try_transition_working_to_idle(run_id, generation, work_revision)?;
    }
    load_by_id(run_id)
        .map_err(|err| err.to_string())?
        .map(|run| run.status)
        .ok_or_else(|| format!("agent_org_run_not_found: {run_id}"))
}

/// Quiescence consumes, but does not create, completion certificates.  These
/// tests seed the certificate as an upstream fact so they can isolate the
/// transition owner.  The certificate validator has separate owning-boundary
/// tests in `agent_org_run_completion`.
fn seed_delivered_certificate_for_quiescence(run_id: &str) {
    let conn = database::db::get_connection().expect("test sqlite connection");
    let (root_session_id, generation): (String, i64) = conn
        .query_row(
            "SELECT root_session_id,activation_generation
             FROM agent_org_runtime_runs WHERE id=?1",
            [run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("current run identity");
    let work_revision: i64 = conn
        .query_row(
            "SELECT work_revision FROM agent_org_runtime_run_progress WHERE org_run_id=?1",
            [run_id],
            |row| row.get(0),
        )
        .expect("current work revision");
    let episode =
        crate::coordination::agent_org_work_episodes::active_with_connection(&conn, run_id)
            .expect("active work episode lookup")
            .expect("active work episode");
    let task_ids = crate::coordination::agent_org_work_episodes::task_ids_with_connection(
        &conn,
        run_id,
        &episode.id,
    )
    .expect("current Task closure");
    let task_ids_json = serde_json::to_string(&task_ids).expect("Task closure JSON");
    let certificate_id = format!("quiescence-certificate-{run_id}");
    let request_id = format!("quiescence-request-{run_id}");
    conn.execute(
        "INSERT INTO agent_org_runtime_run_completion_certificates (
             id,org_run_id,activation_generation,work_revision,request_id,request_digest,
             outcome,summary,coordinator_session_id,coordinator_turn_intent_id,
             evidence_task_ids_json,closure_task_ids_json,task_output_refs_json,
             resolution_links_json,validator_version,created_at
         ) VALUES (?1,?2,?3,?4,?5,?6,'delivered','validated fixture',?7,?8,?9,?9,
                   '[]','[]',1,?10)",
        params![
            certificate_id,
            run_id,
            generation,
            work_revision,
            request_id,
            "0".repeat(64),
            root_session_id,
            format!("quiescence-turn-{run_id}"),
            task_ids_json,
            chrono::Utc::now().to_rfc3339(),
        ],
    )
    .expect("seed completion certificate");
    crate::coordination::agent_org_work_episodes::close_active_in_tx(
        &conn,
        run_id,
        &episode.id,
        crate::coordination::agent_org_work_episodes::WorkEpisodeClosure {
            activation_generation: generation,
            work_revision,
            outcome: "delivered",
            certificate_id: &certificate_id,
            closed_at: &chrono::Utc::now().to_rfc3339(),
        },
    )
    .expect("close fixture work episode");
    conn.execute(
        "INSERT INTO agent_org_runtime_final_summary_receipts (
            receipt_id,org_run_id,activation_generation,certificate_id,evidence_digest,
            attempt,status,coordinator_session_id,turn_intent_id,started_at,terminal_at,
            event_id,created_at,updated_at
         ) VALUES (?1,?2,?3,?4,?5,1,'persisted',?6,?7,?8,?8,?9,?8,?8)",
        params![
            format!("quiescence-summary-{run_id}"),
            run_id,
            generation,
            certificate_id,
            "0".repeat(64),
            root_session_id,
            format!("quiescence-summary-turn-{run_id}"),
            chrono::Utc::now().to_rfc3339(),
            format!("quiescence-event-{run_id}"),
        ],
    )
    .expect("seed persisted final summary receipt");
}

fn create_starting_fixture(has_initial_work: bool) -> AgentOrgRunRecord {
    ensure_runtime_schemas();
    let org = sample_org();
    upsert_session_row_for_member(
        "starting-root",
        None,
        Some("agent-coord"),
        Some(COORDINATOR_MEMBER_ID),
        SessionStatus::Idle.as_str(),
    );
    AgentOrgRunStore::create_starting(CreateStartingAgentOrgRunParams {
        org_id: org.id.clone(),
        coordinator_agent_id: org.agent_id.clone(),
        root_session_id: "starting-root".to_string(),
        org_snapshot: (&org).into(),
        entry_mode: AgentOrgRunEntryMode::StandaloneSession,
        work_item_id: None,
        project_slug: None,
        routine_fire_id: None,
        materialization_intents: vec![
            CreateAgentOrgMaterializationIntent {
                member_id: COORDINATOR_MEMBER_ID.to_string(),
                agent_id: "agent-coord".to_string(),
                session_id: "starting-root".to_string(),
                succeeded: true,
            },
            CreateAgentOrgMaterializationIntent {
                member_id: "member-w1".to_string(),
                agent_id: "agent-w1".to_string(),
                session_id: "starting-member-w1".to_string(),
                succeeded: false,
            },
        ],
        initial_input: has_initial_work.then(|| CreateAgentOrgInitialInput {
            turn_intent_id: "starting-turn".to_string(),
            message_id: "starting-message".to_string(),
            content: "Start the work".to_string(),
            payload_json: serde_json::json!({
                "version": 1,
                "images": ["image-a"],
                "ideContext": null,
                "subAgentIds": [],
            })
            .to_string(),
        }),
    })
    .expect("create Starting fixture")
}

#[test]
fn starting_creation_commits_exact_roster_and_initial_input_receipts() {
    let _sandbox = test_helpers::test_env::sandbox();
    let run = create_starting_fixture(true);

    assert_eq!(run.status, AgentOrgRunStatus::Starting);
    assert_eq!(run.activation_generation, 1);
    assert!(run.has_initial_work);
    let receipts = AgentOrgRunStore::materializations(&run.id).expect("load receipts");
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0].session_id, "starting-root");
    assert_eq!(receipts[0].status, AgentOrgMaterializationStatus::Succeeded);
    assert_eq!(receipts[1].session_id, "starting-member-w1");
    assert_eq!(receipts[1].status, AgentOrgMaterializationStatus::Pending);
    let input = AgentOrgRunStore::initial_input(&run.id)
        .expect("load initial input")
        .expect("initial input exists");
    assert_eq!(input.turn_intent_id, "starting-turn");
    assert!(input.payload_json.contains("image-a"));
}

#[test]
fn starting_finish_requires_exact_member_and_input_durability_then_is_idempotent() {
    let _sandbox = test_helpers::test_env::sandbox();
    let run = create_starting_fixture(true);
    assert!(AgentOrgRunStore::finish_starting(&run.id, 1)
        .expect_err("pending member must block Starting")
        .contains("receipt(s) incomplete"));

    upsert_session_row_for_member(
        "starting-member-w1",
        Some("starting-root"),
        Some("agent-w1"),
        Some("member-w1"),
        SessionStatus::Idle.as_str(),
    );
    assert!(AgentOrgRunStore::mark_materialization_succeeded(
        &run.id,
        "member-w1",
        1,
        "starting-member-w1",
    )
    .expect("certify stable member"));
    assert!(!AgentOrgRunStore::mark_materialization_succeeded(
        &run.id,
        "member-w1",
        1,
        "starting-member-w1",
    )
    .expect("retry same receipt"));
    assert!(AgentOrgRunStore::finish_starting(&run.id, 1)
        .expect_err("missing initial EventStore row must block Starting")
        .contains("not durably materialized"));

    crate::session::persistence::save_user_msg_with_id(
        "starting-message",
        "starting-root",
        "Start the work",
    )
    .expect("persist transcript input");
    database::db::get_connection()
        .expect("db")
        .execute(
            "INSERT INTO events (id, session_id) VALUES (?1, ?2)",
            params!["user-message-starting-message", "starting-root"],
        )
        .expect("persist EventStore proof");

    assert_eq!(
        AgentOrgRunStore::finish_starting(&run.id, 1).expect("finish Starting"),
        AgentOrgRunStatus::Running
    );
    assert_eq!(
        AgentOrgRunStore::finish_starting(&run.id, 1).expect("idempotent finish"),
        AgentOrgRunStatus::Running
    );
    let conn = database::db::get_connection().expect("db");
    let member_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_sessions WHERE session_id='starting-member-w1'",
            [],
            |row| row.get(0),
        )
        .expect("count stable member identity");
    assert_eq!(member_count, 1);
    let turn_status: String = conn
        .query_row(
            "SELECT status FROM session_turn_intents
             WHERE session_id='starting-root' AND turn_intent_id='starting-turn'",
            [],
            |row| row.get(0),
        )
        .expect("load durable initial Turn Intent");
    assert_eq!(turn_status, "queued");
    let context: (i64, String, String, Option<i64>) = conn
        .query_row(
            "SELECT COUNT(*), turn_kind, source_kind, member_dispatch_sequence
             FROM agent_org_runtime_turn_contexts
             WHERE session_id='starting-root' AND turn_intent_id='starting-turn'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("load initial Coordinator context");
    assert_eq!(context, (1, "coordinator".into(), "root_turn".into(), None));
}

#[test]
fn starting_without_initial_work_finishes_idle() {
    let _sandbox = test_helpers::test_env::sandbox();
    let run = create_starting_fixture(false);
    upsert_session_row_for_member(
        "starting-member-w1",
        Some("starting-root"),
        Some("agent-w1"),
        Some("member-w1"),
        SessionStatus::Idle.as_str(),
    );
    AgentOrgRunStore::mark_materialization_succeeded(&run.id, "member-w1", 1, "starting-member-w1")
        .expect("certify stable member");

    assert_eq!(
        AgentOrgRunStore::finish_starting(&run.id, 1).expect("finish no-work Starting"),
        AgentOrgRunStatus::Idle
    );
    assert!(load_by_id(&run.id)
        .expect("load run")
        .expect("run exists")
        .idled_at
        .is_some());
    let conn = database::db::get_connection().expect("db");
    let context_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_turn_contexts WHERE org_run_id=?1",
            [&run.id],
            |row| row.get(0),
        )
        .expect("count no-work contexts");
    assert_eq!(context_count, 0);
}

#[test]
fn starting_finish_revalidates_every_certified_session_identity() {
    let _sandbox = test_helpers::test_env::sandbox();
    let run = create_starting_fixture(false);
    upsert_session_row_for_member(
        "starting-member-w1",
        Some("starting-root"),
        Some("agent-w1"),
        Some("member-w1"),
        SessionStatus::Idle.as_str(),
    );
    AgentOrgRunStore::mark_materialization_succeeded(&run.id, "member-w1", 1, "starting-member-w1")
        .expect("certify stable member");
    database::db::get_connection()
        .expect("db")
        .execute(
            "UPDATE agent_sessions
             SET parent_session_id='wrong-root'
             WHERE session_id='starting-member-w1'",
            [],
        )
        .expect("corrupt certified identity after receipt");

    let error = AgentOrgRunStore::finish_starting(&run.id, 1)
        .expect_err("a stale receipt must not authorize Starting completion");
    assert!(error.starts_with("materialization_identity_mismatch:"));
    assert_eq!(
        AgentOrgRunStore::load(&run.id)
            .expect("load Starting run")
            .expect("run exists")
            .status,
        AgentOrgRunStatus::Starting
    );
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
        "INSERT INTO agent_org_runtime_plan_revisions (
            plan_revision_id,org_run_id,source_task_id,source_member_id,
            source_session_id,source_turn_intent_id,root_session_id,
            revision_number,plan_title,plan_path,plan_content,content_digest,created_at
         ) VALUES ('delete-revision',?1,'delete-task','member-w1',
                   'worker-delete-cascade','delete-intent','root-delete-cascade',1,
                   'Delete plan',?2,'# disposable plan',?3,?4)",
        params![
            &run.id,
            plan_path.to_string_lossy().as_ref(),
            "c".repeat(64),
            &now
        ],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO agent_org_runtime_plan_decisions (
            approval_id,plan_revision_id,request_id,policy,status,created_at
         ) VALUES ('delete-approval','delete-revision','delete-request',
                   'coordinator','pending',?1)",
        params![&now],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO agent_org_runtime_plan_revisions (
            plan_revision_id,org_run_id,source_task_id,source_member_id,
            source_session_id,source_turn_intent_id,root_session_id,
            revision_number,previous_plan_revision_id,plan_title,plan_path,
            plan_content,content_digest,created_at
         ) VALUES ('external-revision',?1,'delete-task','member-w1',
                   'worker-delete-cascade','delete-intent','root-delete-cascade',2,
                   'delete-revision','Historical notes',?2,'# historical corrupt path',?3,?4)",
        params![
            &run.id,
            external_notes.to_string_lossy().as_ref(),
            "d".repeat(64),
            &now
        ],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO agent_org_runtime_plan_decisions (
            approval_id,plan_revision_id,request_id,policy,status,decision_by,
            created_at,resolved_at
         ) VALUES ('external-approval','external-revision','external-request',
                   'coordinator','superseded','automatic',?1,?1)",
        params![&now],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO agent_org_runtime_recovery_attempts
         (org_run_id, action_kind, target_key, reason_fingerprint, attempts,
          next_allowed_at, updated_at)
         VALUES (?1,'member_rewake','member-w1','delete',1,?2,?2)",
        params![&run.id, &now],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO agent_org_runtime_task_annotations
         (id, org_run_id, task_id, kind, body, actor_kind,
          actor_participant_id, created_at)
         VALUES ('delete-note', ?1, 'delete-task', 'audit_note', 'delete',
                 'system', 'system:test', ?2)",
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
        "agent_org_runtime_run_progress",
        "agent_org_runtime_tasks",
        "agent_org_runtime_task_events",
        "agent_org_runtime_task_annotations",
        "agent_org_runtime_inbox",
        "agent_org_runtime_member_interventions",
        "agent_org_runtime_plan_revisions",
        "agent_org_runtime_recovery_attempts",
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
    let decision_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_plan_decisions
             WHERE approval_id IN ('delete-approval','external-approval')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        decision_count, 0,
        "Plan decisions retained after Team delete"
    );
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
fn delete_by_id_preserves_nested_run_intents_and_quiescence_isolation() {
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
        AgentOrgRunStore::assess_run_quiescence(&outer.id).expect("assess outer run quiescence");
    assert_eq!(
        outer_assessment.facts.in_flight_turn_intent_count, 0,
        "untyped intents and nested run work must not block outer run quiescence"
    );
    assert_eq!(outer_assessment.facts.worker_sessions.len(), 1);
    assert_eq!(
        outer_assessment.facts.worker_sessions[0].session_id, "outer-worker",
        "a Running worker owned by a nested run must not block outer quiescence"
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
    AgentOrgRunStore::assess_run_quiescence(&run.id).expect("cyclic quiescence scan terminates");

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
    upsert_session(&record).expect("upsert session row");
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
    let _store = store_with_org(org.clone());
    let _run = create_run_for_root(&org, "root-session-1");
    upsert_session_row("root-session-1", None);

    let ctx = AgentOrgRunStore::context_for_session_with_parent_walk("root-session-1")
        .expect("walk ok")
        .expect("context resolved");
    assert_eq!(ctx.coordinator_agent_id, "agent-coord");
    assert_eq!(ctx.members.len(), 1);
    assert_eq!(ctx.members[0].agent_id, "agent-w1");
}

#[test]
fn context_for_run_uses_launch_snapshot_after_live_org_changes() {
    let _sandbox = test_helpers::test_env::sandbox();
    let mut org = sample_org();
    org.members.push(FlatOrgMember {
        member_id: "member-w2".to_string(),
        name: "Worker Two".to_string(),
        role: "reviewer".to_string(),
        agent_id: "agent-w2".to_string(),
        runtime_config: None,
    });
    org.additional_task_graph_writer_member_ids = vec!["member-w1".to_string()];
    org.member_communication_links = vec![
        crate::definitions::orgs::MemberCommunicationLink::canonical("member-w1", "member-w2"),
    ];
    let store = store_with_org(org.clone());
    let run = create_run_for_root(&org, "root-session-snapshot");
    upsert_session_row("root-session-snapshot", None);

    {
        let mut orgs = store.orgs.lock().expect("org store lock");
        orgs[0].name = "Edited Live Org".to_string();
        orgs[0].role = "edited lead".to_string();
        orgs[0].members[0].member_id = "member-edited".to_string();
        orgs[0].members[0].agent_id = "agent-edited".to_string();
        orgs[0].additional_task_graph_writer_member_ids.clear();
        orgs[0].member_communication_links.clear();
    }

    let ctx = AgentOrgRunStore::context_for_run(&run.id)
        .expect("context lookup ok")
        .expect("context resolved");
    assert_eq!(ctx.org_name, "WalkTest Org");
    assert_eq!(ctx.coordinator_role, "lead");
    assert_eq!(ctx.members.len(), 2);
    assert_eq!(ctx.members[0].member_id, "member-w1");
    assert_eq!(ctx.members[0].agent_id, "agent-w1");
    assert!(ctx.capability_index.is_additional_writer("member-w1"));
    assert!(ctx
        .capability_index
        .members_can_communicate("member-w1", "member-w2"));
}

#[test]
fn context_for_session_with_parent_walk_one_hop_subagent() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let _run = create_run_for_root(&org, "root-session-2");
    upsert_session_row("root-session-2", None);
    upsert_session_row("worker-session-2", Some("root-session-2"));

    let ctx = AgentOrgRunStore::context_for_session_with_parent_walk("worker-session-2")
        .expect("walk ok")
        .expect("context resolved via parent walk");
    assert_eq!(ctx.run_id, _run.id);
    assert_eq!(ctx.coordinator_agent_id, "agent-coord");
}

#[test]
fn context_for_session_with_parent_walk_cli_member_session() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let _run = create_run_for_root(&org, "root-session-cli-walk");
    upsert_session_row("root-session-cli-walk", None);
    upsert_cli_session_row_for_member(
        "cli-worker-session-walk",
        "root-session-cli-walk",
        "claude_code",
        "member-w1",
        "running",
    );

    let ctx = AgentOrgRunStore::context_for_session_with_parent_walk("cli-worker-session-walk")
        .expect("walk ok")
        .expect("context resolved via CLI parent walk");
    assert_eq!(ctx.run_id, _run.id);
    assert_eq!(ctx.coordinator_agent_id, "agent-coord");
}

#[test]
fn context_for_session_with_parent_walk_two_hop_chain() {
    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let _run = create_run_for_root(&org, "root-session-3");
    upsert_session_row("root-session-3", None);
    upsert_session_row("mid-session-3", Some("root-session-3"));
    upsert_session_row("leaf-session-3", Some("mid-session-3"));

    let ctx = AgentOrgRunStore::context_for_session_with_parent_walk("leaf-session-3")
        .expect("walk ok")
        .expect("context resolved via 2-hop walk");
    assert_eq!(ctx.run_id, _run.id);
}

#[test]
fn context_for_session_with_parent_walk_unrelated_session_returns_none() {
    let _sandbox = test_helpers::test_env::sandbox();
    upsert_session_row("orphan-session", None);

    let ctx =
        AgentOrgRunStore::context_for_session_with_parent_walk("orphan-session").expect("walk ok");
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
    ensure_runtime_schemas();

    let ctx =
        AgentOrgRunStore::context_for_session_with_parent_walk("ghost-session").expect("walk ok");
    assert!(ctx.is_none());
}

#[test]
fn context_for_session_with_parent_walk_breaks_on_cycle() {
    // Synthetic cycle: A → B → A. Should bail out cleanly with None
    // (and a warn log; we don't assert on logs here).
    let _sandbox = test_helpers::test_env::sandbox();
    upsert_session_row("cycle-a", Some("cycle-b"));
    upsert_session_row("cycle-b", Some("cycle-a"));

    let ctx = AgentOrgRunStore::context_for_session_with_parent_walk("cycle-a")
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
fn find_worker_session_by_member_id_returns_cli_member_session() {
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
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_id, "cli-worker-active");
    assert_eq!(sessions[0].agent_definition_id, None);
    assert_eq!(sessions[0].cli_agent_type.as_deref(), Some("claude_code"));

    let info = AgentOrgRunStore::find_worker_session_by_member_id(&run.id, "member-w1")
        .expect("query ok")
        .expect("CLI worker found");
    assert_eq!(info.session_id, "cli-worker-active");
    assert_eq!(info.status, crate::core::session::SessionStatus::Running);
}

#[test]
fn find_worker_session_by_member_id_picks_most_recent_when_multi_instance() {
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
    upsert_session_row_for_member(
        "coord-w-new",
        Some("coord-root-rotation"),
        Some("agent-w1"),
        Some("member-w1"),
        "completed",
    );
    upsert_session_row_for_member(
        "coord-shared-other-member",
        Some("coord-root-rotation"),
        Some("agent-w1"),
        Some("member-other"),
        "completed",
    );

    let info = AgentOrgRunStore::find_worker_session_by_member_id(&run.id, "member-w1")
        .expect("query ok")
        .expect("worker found");
    assert_eq!(info.session_id, "coord-w-new");
}

#[test]
fn cross_transport_duplicate_member_uses_fresh_rust_session_and_does_not_block_quiescence() {
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
        metadata: completed_task_metadata("member-w1"),
    })
    .expect("create completed task");
    mark_coordinator_observed_current_work(&run.id);
    stamp_coordinator_terminal_turn("coord-root-cross-transport");

    let assessment = AgentOrgRunStore::assess_run_quiescence(&run.id).expect("assess quiescence");
    assert_eq!(assessment.facts.worker_sessions.len(), 1);
    assert_eq!(
        assessment.facts.worker_sessions[0].session_id,
        "rust-worker-current"
    );
    assert_eq!(assessment.decision, AgentOrgQuiescenceDecision::KeepWorking);
    assert!(assessment.blockers.iter().any(|blocker| matches!(
        blocker,
        AgentOrgQuiescenceBlocker::MissingCompletionCertificate
    )));
    seed_delivered_certificate_for_quiescence(&run.id);
    assert_eq!(
        AgentOrgRunStore::assess_run_quiescence(&run.id)
            .expect("assess certified quiescence")
            .decision,
        AgentOrgQuiescenceDecision::Quiescent
    );
    assert_eq!(
        reconcile_run_to_idle_for_test(&run.id).expect("transition to idle"),
        AgentOrgRunStatus::Idle,
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
fn delivered_candidate_uses_stable_episode_across_pause_resume_generation() {
    use crate::coordination::agent_org_run_completion::{
        certify_in_tx, RunCompletionCandidate, RunCompletionCandidateState, RunCompletionOutcome,
    };
    use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, CreateTaskParams, TaskStatus};
    use crate::coordination::agent_org_turn_contexts::{self, AgentOrgTurnAdmission};
    use crate::foundation::session_bridge::TurnIntentBridgeSource;

    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let root_session_id = "coord-root-completion-candidate";
    let run = create_run_for_root(&org, root_session_id);
    upsert_session_row_for_member(
        root_session_id,
        None,
        Some("agent-coord"),
        Some(COORDINATOR_MEMBER_ID),
        "running",
    );
    let conn = database::db::get_connection().expect("test sqlite connection");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_member_materializations (
             org_run_id,member_id,agent_id,generation,session_id,
             authority_class,status,error_code,error_json,created_at,updated_at
         ) VALUES (?1,?2,'agent-coord',1,?3,'formal','succeeded',NULL,NULL,?4,?4)",
        params![&run.id, COORDINATOR_MEMBER_ID, root_session_id, &now],
    )
    .expect("seed canonical Coordinator materialization");
    AgentOrgTaskStore::create(CreateTaskParams {
        id: "candidate-completed-task".to_string(),
        org_run_id: run.id.clone(),
        subject: "Completed with durable output".to_string(),
        description: String::new(),
        active_form: None,
        owner: Some("member-w1".to_string()),
        status: TaskStatus::Completed,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: completed_task_metadata("member-w1"),
    })
    .expect("create output-backed completed Task");
    conn.execute(
        "UPDATE agent_org_runtime_runs SET activation_generation=3 WHERE id=?1",
        [&run.id],
    )
    .expect("simulate Pause/Resume authorization generations");
    assert_eq!(
        AgentOrgTaskStore::get(&run.id, "candidate-completed-task")
            .expect("load pre-Pause Task")
            .expect("pre-Pause Task exists")
            .activation_generation,
        1,
        "Task audit generation remains the generation that created it"
    );
    let turn_intent_id = "turn-completion-candidate";
    agent_org_turn_contexts::accept(&AgentOrgTurnAdmission::coordinator(
        &run.id,
        root_session_id,
        turn_intent_id,
        Some("message-completion-candidate".to_string()),
        TurnIntentBridgeSource::AgentOrg,
    ))
    .expect("admit exact Coordinator Turn");

    let (revision, _tasks, assessment) =
        AgentOrgRunStore::stage_coordinator_work_revision_and_load_tasks(
            &run.id,
            root_session_id,
            turn_intent_id,
            &[],
        )
        .expect("claim trigger and assess candidate atomically");
    assert!(revision.is_some());
    assert_eq!(assessment.state, RunCompletionCandidateState::Ready);
    assert!(assessment.blockers.is_empty());

    let quiescence = AgentOrgRunStore::assess_run_quiescence(&run.id)
        .expect("read quiescence before certificate");
    assert_eq!(quiescence.decision, AgentOrgQuiescenceDecision::KeepWorking);
    assert!(quiescence.blockers.iter().any(|blocker| matches!(
        blocker,
        AgentOrgQuiescenceBlocker::MissingCompletionCertificate
    )));

    let digest = "a".repeat(64);
    let certificate = certify_in_tx(
        &conn,
        &run.id,
        RunCompletionCandidate {
            request_id: "candidate-parity-call",
            request_digest: &digest,
            outcome: RunCompletionOutcome::Delivered,
            summary: "All formal work has output-backed closure",
            evidence_task_ids: &["candidate-completed-task".to_string()],
            coordinator_session_id: root_session_id,
            coordinator_turn_intent_id: turn_intent_id,
            projected_inbox_ids: &[],
        },
    )
    .expect("ready assessment must agree with the transactional validator");
    assert_eq!(certificate.outcome, RunCompletionOutcome::Delivered);
    assert_eq!(certificate.activation_generation, 3);

    let certified =
        crate::coordination::agent_org_run_completion::assess_delivered_candidate_with_connection(
            &conn,
            &run.id,
            root_session_id,
            turn_intent_id,
            &[],
        );
    assert_eq!(certified.state, RunCompletionCandidateState::Certified);
}

#[test]
fn quiescence_transitions_run_to_idle_when_all_tasks_completed() {
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
        metadata: completed_task_metadata("member-w1"),
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
    conn.execute(
        "INSERT INTO agent_org_runtime_turn_contexts (
             session_id,turn_intent_id,org_run_id,participant_id,turn_kind,
             source_kind,source_id,activation_generation,created_at
         ) VALUES (?1,'final-turn',?2,'coordinator','coordinator',
                   'root_turn','final-turn',1,?3)",
        params!["coord-root-final-complete", &run.id, &now],
    )
    .expect("seed formal coordinator context");
    for pending_status in ["optimistic", "queued", "running"] {
        conn.execute(
            "UPDATE session_turn_intents SET status=?2 WHERE session_id=?1",
            params!["coord-root-final-complete", pending_status],
        )
        .expect("advance pending turn intent");
        assert_eq!(
            reconcile_run_to_idle_for_test(&run.id).expect("reconcile pending intent"),
            AgentOrgRunStatus::Running,
            "a {pending_status} turn intent must keep the run open"
        );
    }
    conn.execute(
        "UPDATE session_turn_intents SET status='completed' WHERE session_id=?1",
        params!["coord-root-final-complete"],
    )
    .expect("set first terminal turn intent");
    assert_eq!(
        reconcile_run_to_idle_for_test(&run.id).expect("uncertified terminal intent"),
        AgentOrgRunStatus::Running,
        "all-terminal work must not become Idle without a completion certificate"
    );
    seed_delivered_certificate_for_quiescence(&run.id);

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
            reconcile_run_to_idle_for_test(&run.id).expect("reconcile terminal intent"),
            AgentOrgRunStatus::Idle,
            "a {terminal_status} turn intent must not keep the run open"
        );
        conn.execute(
            "UPDATE agent_org_runtime_runs SET status='running', idled_at=NULL WHERE id=?1",
            params![&run.id],
        )
        .expect("reset run for next terminal status");
    }
    assert_eq!(
        reconcile_run_to_idle_for_test(&run.id).expect("explicit lifecycle reconcile ok"),
        AgentOrgRunStatus::Idle
    );
    let reloaded = load_by_id(&run.id).expect("load run").expect("run exists");
    assert_eq!(reloaded.status, AgentOrgRunStatus::Idle);
    assert!(reloaded.idled_at.is_some());
}

#[test]
fn quiescence_idles_run_only_after_inbox_is_drained() {
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
        metadata: completed_task_metadata("member-w1"),
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
        reconcile_run_to_idle_for_test(&run.id).unwrap(),
        AgentOrgRunStatus::Running,
        "unread completion facts must be delivered before quiescence"
    );
    AgentInboxStore::mark_many_read(&[row.id]).unwrap();
    assert_eq!(
        reconcile_run_to_idle_for_test(&run.id).unwrap(),
        AgentOrgRunStatus::Running,
        "draining Inbox is necessary but cannot replace the completion certificate"
    );
    seed_delivered_certificate_for_quiescence(&run.id);
    assert_eq!(
        reconcile_run_to_idle_for_test(&run.id).unwrap(),
        AgentOrgRunStatus::Idle,
        "only certified successful work may become Idle"
    );
}

#[test]
fn resolved_undeliverable_inbox_stays_unread_but_no_longer_blocks_quiescence() {
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
        metadata: completed_task_metadata("member-w1"),
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
        "INSERT INTO agent_org_runtime_inbox (
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

    let before = AgentOrgRunStore::assess_run_quiescence(&run.id).expect("assess before repair");
    assert_eq!(before.facts.unread_inbox_count, 1);
    assert_eq!(before.decision, AgentOrgQuiescenceDecision::KeepWorking);

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

    let after = AgentOrgRunStore::assess_run_quiescence(&run.id).expect("assess after repair");
    assert_eq!(after.facts.unread_inbox_count, 0);
    assert_eq!(after.decision, AgentOrgQuiescenceDecision::KeepWorking);
    assert!(after.blockers.iter().any(|blocker| matches!(
        blocker,
        AgentOrgQuiescenceBlocker::MissingCompletionCertificate
    )));
    seed_delivered_certificate_for_quiescence(&run.id);
    assert_eq!(
        reconcile_run_to_idle_for_test(&run.id).expect("transition repaired run"),
        AgentOrgRunStatus::Idle
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
fn explicit_lifecycle_reconcile_idles_empty_board_with_completion_intent() {
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
        reconcile_run_to_idle_for_test(&run.id).expect("reconcile empty board"),
        AgentOrgRunStatus::Idle
    );
    assert_eq!(
        load_by_id(&run.id)
            .expect("load run")
            .expect("run exists")
            .status,
        AgentOrgRunStatus::Idle
    );
}

#[test]
fn archived_sessions_with_open_work_do_not_auto_archive_the_run() {
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
            metadata: completed_task_metadata("member-w1"),
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

    let status = reconcile_run_to_idle_for_test(&run.id).expect("reconcile ok");
    assert_eq!(status, AgentOrgRunStatus::Running);
    let reloaded = load_by_id(&run.id).expect("load run").expect("run exists");
    assert_eq!(reloaded.status, AgentOrgRunStatus::Running);
    assert!(reloaded.idled_at.is_none());
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
        reconcile_run_to_idle_for_test(&run.id).expect("reconcile"),
        AgentOrgRunStatus::Running
    );
}

#[test]
fn idle_cas_and_task_create_have_one_serializable_outcome() {
    use std::sync::{Arc, Barrier};

    use crate::coordination::agent_org_tasks::{AgentOrgTaskStore, CreateTaskParams, TaskStatus};

    let _sandbox = test_helpers::test_env::sandbox();
    let org = sample_org();
    let run = create_run_for_root(&org, "coord-root-quiescence-race");
    upsert_session_row_full(
        "coord-root-quiescence-race",
        None,
        Some("agent-coord"),
        SessionStatus::Completed.as_str(),
    );
    upsert_session(&UnifiedSessionRecord {
        session_id: "worker-quiescence-race".to_string(),
        name: "worker".to_string(),
        status: SessionStatus::Completed.as_str().to_string(),
        session_type: crate::core::session::persistence::session_type::ORG_MEMBER.to_string(),
        parent_session_id: Some("coord-root-quiescence-race".to_string()),
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
        metadata: completed_task_metadata("member-w1"),
    })
    .unwrap();
    mark_coordinator_observed_current_work(&run.id);
    stamp_coordinator_terminal_turn("coord-root-quiescence-race");

    let barrier = Arc::new(Barrier::new(2));
    let reconcile_barrier = Arc::clone(&barrier);
    let reconcile_run_id = run.id.clone();
    let reconcile = std::thread::spawn(move || {
        reconcile_barrier.wait();
        reconcile_run_to_idle_for_test(&reconcile_run_id)
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

    let status = reconcile.join().unwrap().unwrap();
    let created = create.join().unwrap();
    match (status, created) {
        (AgentOrgRunStatus::Idle, Err(error)) => {
            assert!(error.contains("agent_org_run_not_mutable"), "got {error}");
        }
        // The create committed first. Reconcile then sees recoverable open
        // work and correctly leaves the Run Running; this is the other valid
        // serial order. Abandoning here would lose a newly-created task.
        (AgentOrgRunStatus::Running, Ok(task)) => assert_eq!(task.id, "racing-task"),
        (status, result) => panic!("non-serializable quiescence result: {status:?}, {result:?}"),
    }
}
