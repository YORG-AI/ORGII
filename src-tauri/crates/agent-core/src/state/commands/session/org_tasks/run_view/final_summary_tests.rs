use super::final_summary_has_terminal_publication;
use crate::coordination::agent_org_final_summary::{FinalSummaryReceipt, FinalSummaryStatus};

fn receipt(status: FinalSummaryStatus) -> FinalSummaryReceipt {
    FinalSummaryReceipt {
        receipt_id: "summary-receipt".to_string(),
        org_run_id: "run-1".to_string(),
        activation_generation: 1,
        certificate_id: "certificate-1".to_string(),
        evidence_digest: "a".repeat(64),
        attempt: 1,
        status,
        coordinator_session_id: "session-root".to_string(),
        turn_intent_id: Some("summary-turn".to_string()),
        started_at: None,
        terminal_at: None,
        event_id: None,
        typed_error: None,
        can_retry: status == FinalSummaryStatus::Failed,
        created_at: "2026-08-28T00:00:00Z".to_string(),
        updated_at: "2026-08-28T00:00:00Z".to_string(),
    }
}

#[test]
fn certificate_stays_visible_after_terminal_summary_failure() {
    let failed = receipt(FinalSummaryStatus::Failed);
    let persisted = receipt(FinalSummaryStatus::Persisted);
    let running = receipt(FinalSummaryStatus::Running);

    assert!(final_summary_has_terminal_publication(Some(&failed)));
    assert!(final_summary_has_terminal_publication(Some(&persisted)));
    assert!(!final_summary_has_terminal_publication(Some(&running)));
    assert!(!final_summary_has_terminal_publication(None));
}
