use super::budget::{
    budget_disposition, coordinator_notice_allowed, rewake_budget_exhausted, BudgetDisposition,
};
use super::inspect::is_wakeable_status;
use super::recover::recover_listed_runs;
use super::*;
use crate::coordination::agent_org_runs::{AgentOrgRunEntryMode, AgentOrgRunRecord};

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
        archived_at: None,
        archive_receipt_id: None,
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
fn claimed_coordinator_trigger_stays_quiet_across_five_watchdog_ticks() {
    let _sandbox = test_helpers::test_env::sandbox();
    let conn = get_connection().expect("db");
    crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schemas");
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runtime_runs (
             id, org_id, coordinator_agent_id, root_session_id, entry_mode, status,
             created_at, updated_at
         ) VALUES ('quiet-coordinator-run', 'watchdog-org', 'coordinator',
                   'quiet-coordinator-root', 'standalone_session', 'running', ?1, ?1)",
        [&now],
    )
    .expect("seed run");
    conn.execute(
        "INSERT INTO agent_org_runtime_run_progress (
             org_run_id,coordinator_trigger_sequence,
             coordinator_claimed_trigger_sequence,pending_trigger_kind,
             pending_trigger_id,updated_at
         ) VALUES ('quiet-coordinator-run',7,7,'inbox','already-observed',?1)",
        [&now],
    )
    .expect("seed already-claimed trigger");
    let unread = std::collections::HashMap::from([(
        COORDINATOR_MEMBER_ID.to_string(),
        "same-durable-inbox-facts".to_string(),
    )]);

    // The watchdog interval is one minute. Five identical decisions model a
    // five-minute quiet period without sleeping or relying on wall-clock time.
    for _ in 0..5 {
        let (coordinator_unread, wake_member_ids) =
            super::inspect::coordinator_unread_recovery_with_connection(
                &conn,
                "quiet-coordinator-run",
                &unread,
            )
            .expect("inspect claimed Coordinator trigger");
        assert!(coordinator_unread);
        assert!(
            wake_member_ids.is_empty(),
            "the same claimed facts must never schedule another Provider wake"
        );
    }
    let sequences: (i64, i64) = conn
        .query_row(
            "SELECT coordinator_trigger_sequence,coordinator_claimed_trigger_sequence
             FROM agent_org_runtime_run_progress WHERE org_run_id='quiet-coordinator-run'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("read trigger sequences");
    assert_eq!(sequences, (7, 7));
}

#[test]
fn restart_watchdog_never_assigns_an_unreleased_handoff_replacement() {
    let _sandbox = test_helpers::test_env::sandbox();
    let conn = get_connection().expect("db");
    conn.execute_batch(
        "CREATE TABLE agent_sessions (
             session_id TEXT PRIMARY KEY,
             name TEXT NOT NULL,
             status TEXT NOT NULL,
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL,
             parent_session_id TEXT,
             org_member_id TEXT,
             agent_definition_id TEXT
         );
         CREATE TABLE code_sessions (
             session_id TEXT PRIMARY KEY,
             status TEXT NOT NULL,
             updated_at TEXT NOT NULL,
             parent_session_id TEXT,
             org_member_id TEXT,
             cli_agent_type TEXT
         );
         CREATE TABLE session_turn_intents (
             session_id TEXT NOT NULL,
             turn_intent_id TEXT NOT NULL,
             client_message_id TEXT,
             org_run_id TEXT,
             source TEXT NOT NULL,
             status TEXT NOT NULL,
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL,
             PRIMARY KEY(session_id,turn_intent_id)
         );",
    )
    .expect("base session tables");
    crate::coordination::init_agent_org_schemas(&conn).expect("Agent Org schemas");
    let now = Utc::now().to_rfc3339();
    let snapshot = serde_json::json!({
        "schemaVersion": 1,
        "orgId": "watchdog-handoff-org",
        "orgName": "Watchdog handoff Team",
        "coordinatorRole": "Lead",
        "coordinatorAgentId": "coordinator-agent",
        "planApprovalPolicy": "coordinator",
        "members": [{
            "memberId": "member-worker",
            "name": "Worker",
            "role": "Builds",
            "agentId": "worker-agent"
        }],
        "additionalTaskGraphWriterMemberIds": [],
        "memberCommunicationLinks": []
    })
    .to_string();
    conn.execute(
        "INSERT INTO agent_org_runtime_runs(
             id,org_id,coordinator_agent_id,root_session_id,org_snapshot_json,
             entry_mode,status,activation_generation,created_at,updated_at
         ) VALUES ('watchdog-handoff-run','watchdog-handoff-org','coordinator-agent',
                   'watchdog-handoff-root',?1,'standalone_session','running',1,?2,?2)",
        params![snapshot, &now],
    )
    .expect("seed run");
    conn.execute(
        "INSERT INTO agent_org_runtime_run_progress(org_run_id,updated_at)
         VALUES ('watchdog-handoff-run',?1)",
        [&now],
    )
    .expect("seed progress");
    for (session_id, parent_session_id, member_id, agent_id) in [
        (
            "watchdog-handoff-root",
            None,
            None,
            Some("coordinator-agent"),
        ),
        (
            "watchdog-handoff-worker",
            Some("watchdog-handoff-root"),
            Some("member-worker"),
            Some("worker-agent"),
        ),
    ] {
        conn.execute(
            "INSERT INTO agent_sessions(
                 session_id,name,status,created_at,updated_at,parent_session_id,
                 org_member_id,agent_definition_id
             ) VALUES (?1,?1,'idle',?2,?2,?3,?4,?5)",
            params![session_id, &now, parent_session_id, member_id, agent_id],
        )
        .expect("seed session");
    }
    for (id, subject, status, replaces_task_id, cancel_reason_json) in [
        (
            "watchdog-old",
            "Old",
            "cancelled",
            None,
            Some(r#"{"code":"handoff","message":"stopped"}"#),
        ),
        (
            "watchdog-replacement",
            "Blocked replacement",
            "pending",
            Some("watchdog-old"),
            None,
        ),
        (
            "watchdog-ordinary",
            "Ordinary pending task",
            "pending",
            None,
            None,
        ),
    ] {
        conn.execute(
            "INSERT INTO agent_org_runtime_tasks(
                 id,org_run_id,activation_generation,subject,description,owner,status,
                 execution_mode,blocked_by_json,cancel_reason_json,
                 created_by_participant_id,source_turn_intent_id,replaces_task_id,
                 created_at,updated_at
             ) VALUES (?1,'watchdog-handoff-run',1,?2,'fixture','member-worker',?3,
                       'build','[]',?4,'coordinator','fixture-source',?5,?6,?6)",
            params![
                id,
                subject,
                status,
                cancel_reason_json,
                replaces_task_id,
                &now
            ],
        )
        .expect("seed task");
    }
    conn.execute(
        "INSERT INTO agent_org_runtime_task_execution_handoffs(
             id,org_run_id,activation_generation,request_id,request_digest,
             old_task_id,old_owner_member_id,replacement_task_id,state,
             requested_at,updated_at
         ) VALUES ('watchdog-handoff-receipt','watchdog-handoff-run',1,
                   'watchdog-request',?1,'watchdog-old','member-worker',
                   'watchdog-replacement','unknown',?2,?2)",
        params!["e".repeat(64), &now],
    )
    .expect("seed unreleased receipt");

    let plan = super::inspect::inspect_stalled_run_with_connection(&conn, "watchdog-handoff-run")
        .expect("inspect restart state");
    assert_eq!(plan.assignment_actions.len(), 1);
    assert_eq!(
        plan.assignment_actions[0].task_ids,
        vec!["watchdog-ordinary".to_string()]
    );
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
            "INSERT INTO agent_org_runtime_runs (
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
            "INSERT INTO agent_org_runtime_runs (
                 id, org_id, coordinator_agent_id, root_session_id, entry_mode, status,
                 created_at, updated_at,archived_at,archive_receipt_id
             ) VALUES (?1, 'watchdog-org', 'coordinator', ?2, 'standalone_session',
                       ?3, ?4, ?4,
                       CASE WHEN ?3='archived' THEN ?4 ELSE NULL END,
                       CASE WHEN ?3='archived' THEN ?5 ELSE NULL END)",
            params![
                format!("quiet-{status}"),
                format!("root-quiet-{status}"),
                status,
                &now,
                format!("quiet-{status}-archive-receipt")
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
fn coordinator_notice_budget_backs_off_and_resets_on_new_reason() {
    let _sandbox = test_helpers::test_env::sandbox();
    let conn = get_connection().expect("db");
    init_schema(&conn).expect("schema");
    let run_id = format!("run-{}", uuid::Uuid::new_v4());

    assert!(coordinator_notice_allowed(&run_id, "task a stuck").expect("notice"));
    assert!(!coordinator_notice_allowed(&run_id, "task a stuck").expect("backoff"));
    assert!(coordinator_notice_allowed(&run_id, "task b stuck").expect("new reason"));
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
        "INSERT INTO agent_org_runtime_recovery_attempts
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
