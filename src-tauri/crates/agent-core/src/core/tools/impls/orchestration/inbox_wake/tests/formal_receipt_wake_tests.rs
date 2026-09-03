use super::*;

#[test]
fn formal_receipt_fingerprint_is_order_stable_and_deduplicated() {
    let first = vec!["receipt-b".to_string(), "receipt-a".to_string()];
    let reordered = vec![
        "receipt-a".to_string(),
        "receipt-b".to_string(),
        "receipt-a".to_string(),
    ];

    assert_eq!(
        formal_receipt_rewake_fingerprint(Some(&first)),
        formal_receipt_rewake_fingerprint(Some(&reordered))
    );
    assert_eq!(formal_receipt_rewake_fingerprint(Some(&[])), None);
}

#[test]
fn a_new_formal_receipt_starts_a_fresh_rewake_episode() {
    use crate::coordination::agent_org_watchdog::{
        commit_member_rewake_reservation, reserve_member_rewake_dispatch,
        MemberRewakeReservationOutcome,
    };

    let _sandbox = test_helpers::test_env::sandbox();
    let conn = database::db::get_connection().expect("test database");
    crate::coordination::agent_org_watchdog::init_schema(&conn).expect("rewake schema");
    let run_id = "formal-receipt-rewake-run";
    let member_id = crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;
    let first = formal_receipt_rewake_fingerprint(Some(&["receipt-1".to_string()]))
        .expect("first fingerprint");
    let second = formal_receipt_rewake_fingerprint(Some(&["receipt-2".to_string()]))
        .expect("second fingerprint");

    let first_reservation = match reserve_member_rewake_dispatch(run_id, member_id, &first)
        .expect("reserve first receipt")
    {
        MemberRewakeReservationOutcome::Reserved(reservation) => reservation,
        MemberRewakeReservationOutcome::Deferred => panic!("first receipt unexpectedly deferred"),
    };
    commit_member_rewake_reservation(&first_reservation).expect("commit first reservation");
    assert!(matches!(
        reserve_member_rewake_dispatch(run_id, member_id, &first).expect("repeat first receipt"),
        MemberRewakeReservationOutcome::Deferred
    ));

    let second_reservation = match reserve_member_rewake_dispatch(run_id, member_id, &second)
        .expect("reserve newly committed receipt")
    {
        MemberRewakeReservationOutcome::Reserved(reservation) => reservation,
        MemberRewakeReservationOutcome::Deferred => panic!("new receipt inherited stale backoff"),
    };
    commit_member_rewake_reservation(&second_reservation).expect("commit second reservation");
}
