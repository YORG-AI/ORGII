use super::budget::{
    budget_disposition, coordinator_notice_allowed, rewake_budget_exhausted, BudgetDisposition,
};
use super::inspect::is_wakeable_status;
use super::recover::{
    dispatch_wakes_if_run_writable, execute_stall_recovery_plan, recover_listed_runs,
    run_best_effort_cleanup,
};
use super::*;
use crate::coordination::agent_org_runs::{AgentOrgRunEntryMode, AgentOrgRunRecord};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier};

#[derive(Default)]
struct RecordingWakeHook {
    calls: AtomicUsize,
}

impl InboxWakeHook for RecordingWakeHook {
    fn wake_member(&self, _member_id: &str, _org_run_id: &str) {
        self.calls.fetch_add(1, Ordering::SeqCst);
    }
}

struct BlockingWakeHook {
    calls: AtomicUsize,
    entered: Barrier,
    release: Barrier,
}

impl InboxWakeHook for BlockingWakeHook {
    fn wake_member(&self, _member_id: &str, _org_run_id: &str) {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.wait();
        self.release.wait();
    }
}

fn seed_running_run(conn: &Connection, run_id: &str, root_session_id: &str) {
    crate::coordination::agent_org_runs::init_schema(conn).expect("run schema");
    crate::coordination::agent_org_plan_approvals::init_schema(conn).expect("plan approval schema");
    init_schema(conn).expect("watchdog schema");
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_runs (
             id, org_id, coordinator_agent_id, root_session_id,
             org_snapshot_json, entry_mode, status, work_item_id,
             project_slug, routine_fire_id, summary, last_error,
             created_at, updated_at, completed_at
         ) VALUES (?1, 'org', 'coordinator-agent', ?2,
                   NULL, 'standalone_session', 'running', NULL,
                   NULL, NULL, NULL, NULL, ?3, ?3, NULL)",
        params![run_id, root_session_id, &now],
    )
    .expect("seed running run");
}

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
        work_item_id: None,
        project_slug: None,
        routine_fire_id: None,
        summary: None,
        last_error: None,
        created_at: now.clone(),
        updated_at: now,
        completed_at: None,
        continued_from_run_id: None,
        originating_message_id: None,
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
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    seed_running_run(&conn, &run_id, "root-reserved");
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
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    seed_running_run(&conn, &run_id, "root-new-input");
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
fn fenced_running_run_is_excluded_and_stale_recovery_is_a_noop() {
    let _sandbox = test_helpers::test_env::sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let root_session_id = "root-fenced-watchdog";
    let conn = get_connection().expect("db");
    seed_running_run(&conn, &run_id, root_session_id);
    drop(conn);

    crate::coordination::agent_org_runs::establish_conversation_delete_fence(root_session_id)
        .expect("establish durable root fence");
    let conn = get_connection().expect("db");
    conn.execute(
        "UPDATE agent_org_runs SET status='running' WHERE id=?1",
        params![&run_id],
    )
    .expect("keep run running to isolate root-fence behavior");

    assert!(
        AgentOrgRunStore::list_running_runs(usize::MAX)
            .expect("list writable running runs")
            .into_iter()
            .all(|run| run.id != run_id),
        "watchdog scan must exclude a fenced root"
    );
    assert!(
        inspect_stalled_run(&run_id)
            .expect("inspect fenced run")
            .is_noop(),
        "direct inspection must not derive recovery work for a fenced root"
    );

    let stale_plan = StallRecoveryPlan {
        wake_member_ids: vec!["member-stale".to_string()],
        ..StallRecoveryPlan::default()
    };
    let wake_hook = RecordingWakeHook::default();
    assert_eq!(
        execute_stall_recovery_plan(&run_id, stale_plan.clone(), &wake_hook)
            .expect("execute stale plan"),
        stale_plan
    );
    assert_eq!(wake_hook.calls.load(Ordering::SeqCst), 0);
    assert!(matches!(
        reserve_member_rewake_dispatch(&run_id, "member-stale", "unread-stale")
            .expect("fenced reservation is deferred"),
        MemberRewakeReservationOutcome::Deferred
    ));
    let recovery_attempts: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_recovery_attempts WHERE org_run_id=?1",
            params![&run_id],
            |row| row.get(0),
        )
        .expect("count recovery attempts");
    assert_eq!(recovery_attempts, 0);
}

#[test]
fn wake_callback_and_root_fence_have_one_serial_order() {
    let _sandbox = test_helpers::test_env::sandbox();
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let root_session_id = "root-watchdog-callback-race";
    let conn = get_connection().expect("db");
    seed_running_run(&conn, &run_id, root_session_id);
    drop(conn);

    let hook = Arc::new(BlockingWakeHook {
        calls: AtomicUsize::new(0),
        entered: Barrier::new(2),
        release: Barrier::new(2),
    });
    let dispatch_hook = Arc::clone(&hook);
    let dispatch_run_id = run_id.clone();
    let dispatch = std::thread::spawn(move || {
        dispatch_wakes_if_run_writable(
            &dispatch_run_id,
            std::iter::once("member-race"),
            dispatch_hook.as_ref(),
        )
    });
    hook.entered.wait();

    let fence_started = Arc::new(Barrier::new(2));
    let fence_started_in_thread = Arc::clone(&fence_started);
    let fence = std::thread::spawn(move || {
        fence_started_in_thread.wait();
        crate::coordination::agent_org_runs::establish_conversation_delete_fence(root_session_id)
    });
    fence_started.wait();
    let conn = get_connection().expect("read before callback release");
    let fenced: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_org_conversation_delete_fences WHERE root_session_id=?1)",
            [root_session_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!fenced, "fence must wait for the in-flight callback gate");
    drop(conn);

    hook.release.wait();
    dispatch.join().unwrap().unwrap();
    fence.join().unwrap().unwrap();
    assert_eq!(hook.calls.load(Ordering::SeqCst), 1);
    let conn = get_connection().expect("read committed fence");
    let fenced: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_org_conversation_delete_fences WHERE root_session_id=?1)",
            [root_session_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(fenced);
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
fn maintenance_failure_is_best_effort() {
    run_best_effort_cleanup("injected", || Err("failure".to_string()));
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
