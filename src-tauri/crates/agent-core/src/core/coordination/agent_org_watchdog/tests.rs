use super::budget::{budget_disposition, coordinator_notice_allowed, BudgetDisposition};
use super::inspect::is_wakeable_status;
use super::recover::{recover_listed_runs, run_best_effort_cleanup};
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
        work_item_id: None,
        project_slug: None,
        routine_fire_id: None,
        summary: None,
        last_error: None,
        created_at: now.clone(),
        updated_at: now,
        completed_at: None,
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
