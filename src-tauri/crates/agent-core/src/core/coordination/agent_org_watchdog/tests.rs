use super::budget::{
    budget_disposition, coordinator_notice_allowed, rewake_budget_exhausted, BudgetDisposition,
};
use super::inspect::is_wakeable_status;
use super::recover::{
    next_running_scan_batch, recover_listed_runs, repair_stale_in_flight_intents,
};
use super::*;
use crate::coordination::agent_org_runs::{
    AgentOrgRunEntryMode, AgentOrgRunRecord, CreateAgentOrgRunParams,
};
use crate::definitions::orgs::OrgDefinition;

fn fake_run(id: &str) -> AgentOrgRunRecord {
    let now = Utc::now().to_rfc3339();
    AgentOrgRunRecord {
        id: id.to_string(),
        org_id: "org".to_string(),
        coordinator_agent_id: "coordinator-agent".to_string(),
        root_session_id: Some(format!("root-{id}")),
        org_snapshot_json: None,
        entry_mode: AgentOrgRunEntryMode::StandaloneSession,
        status: AgentOrgRunStatus::Running,
        activation_generation: 1,
        has_initial_work: true,
        work_item_id: None,
        project_slug: None,
        routine_fire_id: None,
        summary: None,
        failure_json: None,
        last_error: None,
        last_activity_outcome: None,
        created_at: now.clone(),
        updated_at: now,
        idled_at: None,
    }
}

#[test]
fn wakeable_status_includes_idle_and_terminal_but_not_running() {
    assert!(is_wakeable_status(SessionStatus::Idle));
    assert!(is_wakeable_status(SessionStatus::Failed));
    assert!(!is_wakeable_status(SessionStatus::Running));
}

#[test]
fn member_rewake_reservation_is_atomic_and_refundable() {
    let _sandbox = test_helpers::test_env::sandbox();
    let conn = get_connection().expect("db");
    init_schema(&conn).expect("schema");
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let member_id = "member-reserved";
    let fingerprint = "unread-42";

    let first = match reserve_member_rewake_dispatch(&run_id, member_id, fingerprint)
        .expect("reserve first dispatch")
    {
        MemberRewakeReservationOutcome::Reserved(reservation) => reservation,
        MemberRewakeReservationOutcome::Deferred => panic!("first dispatch must reserve"),
    };
    assert!(matches!(
        reserve_member_rewake_dispatch(&run_id, member_id, fingerprint)
            .expect("concurrent reservation gate"),
        MemberRewakeReservationOutcome::Deferred
    ));
    assert!(refund_member_rewake_reservation(&first).expect("refund failed dispatch"));
    assert!(matches!(
        reserve_member_rewake_dispatch(&run_id, member_id, fingerprint)
            .expect("reserve after refund"),
        MemberRewakeReservationOutcome::Reserved(_)
    ));
}

#[test]
fn stale_rewake_refund_cannot_undo_newer_input() {
    let _sandbox = test_helpers::test_env::sandbox();
    let conn = get_connection().expect("db");
    init_schema(&conn).expect("schema");
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let member_id = "member-new-input";
    let old = match reserve_member_rewake_dispatch(&run_id, member_id, "unread-1")
        .expect("reserve old fingerprint")
    {
        MemberRewakeReservationOutcome::Reserved(reservation) => reservation,
        MemberRewakeReservationOutcome::Deferred => panic!("old fingerprint must reserve"),
    };
    let current = match reserve_member_rewake_dispatch(&run_id, member_id, "unread-2")
        .expect("new durable input resets budget")
    {
        MemberRewakeReservationOutcome::Reserved(reservation) => reservation,
        MemberRewakeReservationOutcome::Deferred => {
            panic!("new fingerprint must have its own reservation")
        }
    };

    assert!(
        !refund_member_rewake_reservation(&old).expect("stale refund"),
        "an old dispatch token must not roll back newer durable input"
    );
    commit_member_rewake_reservation(&current).expect("commit current dispatch");
    assert_eq!(
        budget_disposition(&run_id, MEMBER_REWAKE, member_id, "unread-2").expect("read budget"),
        BudgetDisposition::Backoff
    );
}

#[test]
fn one_failed_run_does_not_skip_later_runs() {
    let first = fake_run("run-first");
    let second = fake_run("run-second");
    let mut inspected = Vec::new();

    let error = recover_listed_runs((), vec![first, second], |(), run_id| {
        inspected.push(run_id.to_string());
        if run_id == "run-first" {
            Err("injected failure".to_string())
        } else {
            Ok(())
        }
    })
    .expect_err("aggregate error");

    assert!(error.contains("run-first"));
    assert_eq!(inspected, vec!["run-first", "run-second"]);
}

#[test]
fn watchdog_constants_match_the_single_bounded_design() {
    assert_eq!(WATCHDOG_INTERVAL_SECS, 60);
    assert_eq!(WATCHDOG_MAX_RUNS, 100);
    assert_eq!(WATCHDOG_SCAN_BUDGET, Duration::from_millis(250));
}

#[test]
fn shared_scan_deadline_is_checked_at_each_team_boundary() {
    let first = fake_run("run-slow");
    let second = fake_run("run-after-budget");
    let mut inspected = Vec::new();

    recover_listed_runs((), vec![first, second], |(), run_id| {
        inspected.push(run_id.to_string());
        if run_id == "run-slow" {
            std::thread::sleep(Duration::from_millis(275));
        }
        Ok(())
    })
    .expect("budget expiry is a bounded stop, not an error");

    assert_eq!(inspected, vec!["run-slow"]);
}

#[test]
fn running_query_is_limited_and_never_visits_quiet_states() {
    let _sandbox = test_helpers::test_env::sandbox();
    let conn = get_connection().expect("db");
    crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schemas");
    let now = Utc::now().to_rfc3339();
    for index in 0..105 {
        conn.execute(
            "INSERT INTO agent_org_runs (
                 id, org_id, coordinator_agent_id, root_session_id, entry_mode, status,
                 created_at, updated_at
             ) VALUES (?1, 'watchdog-org', 'coordinator', ?2, 'standalone_session',
                       'running', ?3, ?3)",
            params![
                format!("running-{index:03}"),
                format!("root-running-{index:03}"),
                &now
            ],
        )
        .expect("seed Working run");
    }
    for status in ["starting", "paused", "idle", "failed", "archived"] {
        conn.execute(
            "INSERT INTO agent_org_runs (
                 id, org_id, coordinator_agent_id, root_session_id, entry_mode, status,
                 created_at, updated_at
             ) VALUES (?1, 'watchdog-org', 'coordinator', ?2, 'standalone_session',
                       ?3, ?4, ?4)",
            params![
                format!("quiet-{status}"),
                format!("root-quiet-{status}"),
                status,
                &now
            ],
        )
        .expect("seed quiet run");
    }

    let runs = AgentOrgRunStore::list_running_runs(WATCHDOG_MAX_RUNS).expect("bounded query");
    assert_eq!(runs.len(), WATCHDOG_MAX_RUNS);
    assert!(runs
        .iter()
        .all(|run| run.status == AgentOrgRunStatus::Running));
    assert_eq!(runs.first().map(|run| run.id.as_str()), Some("running-000"));
    assert_eq!(runs.last().map(|run| run.id.as_str()), Some("running-099"));
}

#[test]
fn startup_prune_clears_all_reservations_and_non_running_budget_rows() {
    let _sandbox = test_helpers::test_env::sandbox();
    let conn = get_connection().expect("db");
    crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schemas");
    let now = Utc::now().to_rfc3339();
    for (run_id, status) in [("prune-running", "running"), ("prune-idle", "idle")] {
        conn.execute(
            "INSERT INTO agent_org_runs (
                 id, org_id, coordinator_agent_id, root_session_id, entry_mode, status,
                 created_at, updated_at
             ) VALUES (?1, 'prune-org', 'coordinator', ?2, 'standalone_session', ?3, ?4, ?4)",
            params![run_id, format!("root-{run_id}"), status, &now],
        )
        .expect("seed run");
    }
    for (run_id, token) in [
        ("prune-running", Some("leaked-token-running")),
        ("prune-idle", Some("leaked-token-idle")),
        ("prune-missing-run", None::<&str>),
    ] {
        conn.execute(
            "INSERT INTO agent_org_recovery_attempts
                 (org_run_id, action_kind, target_key, reason_fingerprint, attempts,
                  next_allowed_at, updated_at, reservation_token)
             VALUES (?1, ?2, 'member-x', 'fp', 1, ?3, ?3, ?4)",
            params![run_id, MEMBER_REWAKE, &now, token],
        )
        .expect("seed recovery attempt");
    }

    let report = startup_prune_recovery_state().expect("startup prune");
    assert_eq!(report.reservations_cleared, 2);
    assert_eq!(report.attempts_pruned, 2);

    let leaked_tokens: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_recovery_attempts
             WHERE reservation_token IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .expect("count tokens");
    assert_eq!(leaked_tokens, 0, "no reservation survives its process");
    let remaining: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT org_run_id FROM agent_org_recovery_attempts ORDER BY org_run_id")
            .expect("prepare");
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query");
        rows.collect::<Result<Vec<_>, _>>().expect("collect")
    };
    assert_eq!(
        remaining,
        vec!["prune-running".to_string()],
        "budget rows survive only for still-running teams"
    );
}

#[test]
fn rotation_cursor_visits_every_working_run_across_ticks() {
    let _sandbox = test_helpers::test_env::sandbox();
    let conn = get_connection().expect("db");
    crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schemas");
    const POPULATION: usize = 5;
    const TICK_LIMIT: usize = 2;
    for index in 0..POPULATION {
        conn.execute(
            "INSERT INTO agent_org_runs (
                 id, org_id, coordinator_agent_id, root_session_id, entry_mode, status,
                 created_at, updated_at
             ) VALUES (?1, 'rotation-org', 'coordinator', ?2, 'standalone_session',
                       'running', ?3, ?3)",
            params![
                format!("rotation-{index:02}"),
                format!("root-rotation-{index:02}"),
                format!("2026-08-01T00:00:0{index}Z"),
            ],
        )
        .expect("seed Working run");
    }

    let mut cursor: Option<(String, String)> = None;
    let mut visited = HashSet::new();
    let mut first_batch_ids = Vec::new();
    for tick in 0..3 {
        let batch = next_running_scan_batch(&mut cursor, TICK_LIMIT).expect("rotated batch");
        assert!(batch.len() <= TICK_LIMIT);
        if tick == 0 {
            first_batch_ids = batch.iter().map(|run| run.id.clone()).collect();
        }
        for run in batch {
            visited.insert(run.id);
        }
    }
    assert_eq!(
        visited.len(),
        POPULATION,
        "a population larger than one batch must be fully visited across ticks"
    );

    // The wrap-around continues rotating instead of resetting to the same
    // oldest batch every tick (the starvation being fixed).
    let batch = next_running_scan_batch(&mut cursor, TICK_LIMIT).expect("post-wrap batch");
    assert!(
        batch.iter().any(|run| !first_batch_ids.contains(&run.id))
            || first_batch_ids.len() < TICK_LIMIT,
        "successive ticks must not restart at the identical oldest batch"
    );
}

#[test]
fn coordinator_notice_budget_backs_off_and_resets_on_new_reason() {
    let _sandbox = test_helpers::test_env::sandbox();
    let conn = get_connection().expect("db");
    init_schema(&conn).expect("schema");
    let run_id = format!("run-{}", uuid::Uuid::new_v4());

    assert!(coordinator_notice_allowed(&run_id, "task a stuck").expect("notice"));
    assert!(!coordinator_notice_allowed(&run_id, "task a stuck").expect("backoff"));
    assert!(coordinator_notice_allowed(&run_id, "task b stuck").expect("new reason"));
}

fn ensure_watchdog_runtime_schemas() {
    let conn = get_connection().expect("test sqlite connection");
    crate::foundation::persistence::test_schema::ensure_agent_sessions_schema(&conn);
    crate::foundation::persistence::session_snapshots::ensure_tables_with(&conn)
        .expect("agent sessions schema");
    crate::core::session::persistence::init(&conn).expect("unified session schema");
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
    .expect("runtime session schemas");
}

/// A Working run that is quiescent in every dimension except one `running`
/// turn intent whose scheduler no longer exists (crash mid-turn).
fn seed_wedged_working_run(intent_updated_at: &str) -> String {
    ensure_watchdog_runtime_schemas();
    let root_session_id = format!("wedged-root-{}", uuid::Uuid::new_v4());
    crate::core::session::persistence::upsert_session(
        &crate::core::session::persistence::UnifiedSessionRecord {
            session_id: root_session_id.clone(),
            name: "wedged root".to_string(),
            status: SessionStatus::Idle.as_str().to_string(),
            session_type: "agent".to_string(),
            agent_definition_id: Some("agent-coord".to_string()),
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
            ..Default::default()
        },
    )
    .expect("upsert quiescent coordinator session");
    let run = AgentOrgRunStore::create(CreateAgentOrgRunParams {
        org_id: "wedged-org".to_string(),
        coordinator_agent_id: "agent-coord".to_string(),
        root_session_id: Some(root_session_id.clone()),
        org_snapshot: OrgDefinition {
            id: "wedged-org".to_string(),
            name: "Wedged Org".to_string(),
            role: "lead".to_string(),
            agent_id: "agent-coord".to_string(),
            description: None,
            hierarchy_mode: Default::default(),
            plan_approval_policy: Default::default(),
            children: Vec::new(),
        },
        entry_mode: AgentOrgRunEntryMode::StandaloneSession,
        status: AgentOrgRunStatus::Running,
        work_item_id: None,
        project_slug: None,
        routine_fire_id: None,
    })
    .expect("create Working run");
    agent_org_tasks::AgentOrgTaskStore::create(agent_org_tasks::CreateTaskParams {
        id: "wedged-task-done".to_string(),
        org_run_id: run.id.clone(),
        subject: "done".to_string(),
        description: String::new(),
        active_form: None,
        owner: None,
        status: TaskStatus::Completed,
        blocks: Vec::new(),
        blocked_by: Vec::new(),
        metadata: None,
    })
    .expect("create completed task");
    let revision = AgentOrgRunStore::stage_coordinator_work_revision(&run.id)
        .expect("stage coordinator work revision")
        .expect("running run has a work revision");
    AgentOrgRunStore::mark_coordinator_observed_work_revision(&run.id, revision)
        .expect("mark coordinator observed revision");

    let conn = get_connection().expect("test sqlite connection");
    conn.execute(
        "INSERT INTO session_turn_intents (
             session_id, turn_intent_id, org_run_id, source, status,
             created_at, updated_at
         ) VALUES (?1, 'wedged-turn-intent', ?2, 'agent_org', 'running', ?3, ?3)",
        params![&root_session_id, &run.id, intent_updated_at],
    )
    .expect("seed crash-orphaned running intent");
    run.id
}

#[test]
fn wedged_running_intent_older_than_grace_is_repaired_and_run_can_idle() {
    let _sandbox = test_helpers::test_env::sandbox();
    let aged =
        (Utc::now() - ChronoDuration::seconds(STALE_INTENT_REPAIR_GRACE_SECS + 300)).to_rfc3339();
    let run_id = seed_wedged_working_run(&aged);

    let assessment =
        AgentOrgRunStore::assess_run_quiescence(&run_id).expect("assess wedged run");
    assert_eq!(
        assessment.decision,
        AgentOrgQuiescenceDecision::KeepWorking,
        "the crash-orphaned intent must block quiescence before repair"
    );
    assert_eq!(assessment.facts.in_flight_turn_intent_count, 1);

    let plan = inspect_stalled_run(&run_id).expect("inspect wedged run");
    assert_eq!(plan.stale_intent_repairs.len(), 1);
    assert_eq!(plan.stale_intent_repairs[0].turn_intent_id, "wedged-turn-intent");
    assert!(!plan.terminal_candidate);

    let repaired =
        repair_stale_in_flight_intents(&run_id, &plan.stale_intent_repairs).expect("repair");
    assert_eq!(repaired, 1);
    let status: String = get_connection()
        .expect("db")
        .query_row(
            "SELECT status FROM session_turn_intents WHERE turn_intent_id='wedged-turn-intent'",
            [],
            |row| row.get(0),
        )
        .expect("load repaired intent");
    assert_eq!(status, "failed");

    // The next quiescence pass can now settle the team.
    let assessment =
        AgentOrgRunStore::assess_run_quiescence(&run_id).expect("assess repaired run");
    assert_eq!(assessment.decision, AgentOrgQuiescenceDecision::Quiescent);
    let generation = assessment
        .facts
        .activation_generation
        .expect("activation generation");
    let work_revision = assessment
        .facts
        .progress
        .as_ref()
        .map(|progress| progress.work_revision)
        .expect("work revision");
    assert!(
        AgentOrgRunStore::try_transition_working_to_idle(&run_id, generation, work_revision)
            .expect("idle transition"),
        "the repaired team must be reconcilable to Idle"
    );
}

#[test]
fn young_running_intent_is_never_auto_repaired() {
    let _sandbox = test_helpers::test_env::sandbox();
    let run_id = seed_wedged_working_run(&Utc::now().to_rfc3339());

    let plan = inspect_stalled_run(&run_id).expect("inspect young-intent run");
    assert!(
        plan.stale_intent_repairs.is_empty(),
        "an intent inside the grace window must never be terminalized"
    );
    assert!(!plan.terminal_candidate);
}

#[test]
fn rewake_budget_exhaustion_requires_all_attempts_and_an_expired_cooldown() {
    let _sandbox = test_helpers::test_env::sandbox();
    let conn = get_connection().expect("db");
    init_schema(&conn).expect("schema");
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let member_id = "member-exhausted";
    let fingerprint = "same-input";
    assert!(!rewake_budget_exhausted(&run_id, member_id, fingerprint).expect("initial budget"));
    let expired_at = (Utc::now() - ChronoDuration::seconds(1)).to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_recovery_attempts
             (org_run_id, action_kind, target_key, reason_fingerprint, attempts,
              next_allowed_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![
            &run_id,
            MEMBER_REWAKE,
            member_id,
            fingerprint,
            RECOVERY_DELAYS_SECS.len() as i64,
            &expired_at,
        ],
    )
    .expect("seed exhausted budget");
    assert!(rewake_budget_exhausted(&run_id, member_id, fingerprint).expect("exhausted budget"));
}
