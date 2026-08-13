use crate::orchestrator::proof_of_work::*;
use crate::projects::types::{PrStatus, ReviewFeedback, ReviewOutcome, WorkItemFrontmatter};

fn empty_frontmatter() -> WorkItemFrontmatter {
    WorkItemFrontmatter {
        id: String::new(),
        short_id: String::new(),
        title: String::new(),
        project: None,
        status: "backlog".to_string(),
        priority: "none".to_string(),
        assignee: None,
        labels: Vec::new(),
        milestone: None,
        parent: None,
        stage: None,
        start_date: None,
        target_date: None,
        created_by: None,
        origin_session: None,
        created_at: String::new(),
        updated_at: String::new(),
        deleted_at: None,
        starred: false,
        todos: Vec::new(),
        comments: Vec::new(),
        history: Vec::new(),
        delegations: Vec::new(),
        linked_sessions: Vec::new(),
        handoff: None,
        proof_of_work: None,
        orchestrator_config: None,
        orchestrator_state: None,
        follow_up_items: Vec::new(),
        assignee_type: None,
        schedule: None,
        routine_source: None,
        execution_lock: None,
        close_out: None,
        work_products: Vec::new(),
    }
}

// ============================================
// ensure_proof_of_work
// ============================================

#[test]
fn ensure_proof_of_work_creates_default() {
    let mut fm = empty_frontmatter();
    ensure_proof_of_work(&mut fm);
    let pow = fm.proof_of_work.as_ref().unwrap();
    assert!(pow.branch.is_none());
    assert_eq!(pow.total_cost_usd, 0.0);
    assert_eq!(pow.total_tokens, 0);
    assert!(pow.pr_url.is_none());
    assert!(pow.review_outcome.is_none());
}

#[test]
fn ensure_proof_of_work_idempotent() {
    let mut fm = empty_frontmatter();
    {
        let pow1 = ensure_proof_of_work(&mut fm);
        pow1.branch = Some("same-instance".to_string());
    }
    let pow2 = ensure_proof_of_work(&mut fm);
    assert_eq!(pow2.branch.as_deref(), Some("same-instance"));
}

// ============================================
// set_branch
// ============================================

#[test]
fn set_branch_sets_name() {
    let mut fm = empty_frontmatter();
    set_branch(&mut fm, "feature/xyz");
    let pow = fm.proof_of_work.as_ref().unwrap();
    assert_eq!(pow.branch.as_deref(), Some("feature/xyz"));
}

// ============================================
// accumulate_cost
// ============================================

#[test]
fn accumulate_cost_adds_and_accumulates() {
    let mut fm = empty_frontmatter();
    accumulate_cost(&mut fm, 0.5, 1000);
    let pow = fm.proof_of_work.as_ref().unwrap();
    assert_eq!(pow.total_cost_usd, 0.5);
    assert_eq!(pow.total_tokens, 1000);

    accumulate_cost(&mut fm, 0.3, 500);
    let pow = fm.proof_of_work.as_ref().unwrap();
    assert_eq!(pow.total_cost_usd, 0.8);
    assert_eq!(pow.total_tokens, 1500);
}

// ============================================
// set_pr
// ============================================

#[test]
fn set_pr_sets_url_and_status() {
    let mut fm = empty_frontmatter();
    set_pr(
        &mut fm,
        "https://github.com/org/repo/pull/42",
        PrStatus::Open,
    );
    let pow = fm.proof_of_work.as_ref().unwrap();
    assert_eq!(
        pow.pr_url.as_deref(),
        Some("https://github.com/org/repo/pull/42")
    );
    assert_eq!(pow.pr_status, Some(PrStatus::Open));
}

// ============================================
// set_review_outcome
// ============================================

#[test]
fn set_review_outcome_sets_outcome() {
    let mut fm = empty_frontmatter();
    set_review_outcome(&mut fm, ReviewOutcome::Approved);
    let pow = fm.proof_of_work.as_ref().unwrap();
    assert_eq!(pow.review_outcome, Some(ReviewOutcome::Approved));
}

// ============================================
// set_review_feedback
// ============================================

#[test]
fn set_review_feedback_sets_feedback_and_outcome() {
    let mut fm = empty_frontmatter();
    let feedback = ReviewFeedback {
        outcome: ReviewOutcome::ChangesRequested,
        summary: "Needs work".to_string(),
        comments: Vec::new(),
        session_id: "sess-1".to_string(),
        reviewed_at: "2025-01-01T00:00:00Z".to_string(),
        resolved_from_previous: Vec::new(),
    };
    set_review_feedback(&mut fm, feedback);
    let pow = fm.proof_of_work.as_ref().unwrap();
    assert_eq!(pow.review_outcome, Some(ReviewOutcome::ChangesRequested));
    assert!(pow.review_feedback.is_some());
    assert_eq!(pow.review_feedback.as_ref().unwrap().summary, "Needs work");
}

#[test]
fn set_review_feedback_second_call_pushes_to_history() {
    let mut fm = empty_frontmatter();
    let feedback1 = ReviewFeedback {
        outcome: ReviewOutcome::ChangesRequested,
        summary: "First".to_string(),
        comments: Vec::new(),
        session_id: "sess-1".to_string(),
        reviewed_at: "2025-01-01T00:00:00Z".to_string(),
        resolved_from_previous: Vec::new(),
    };
    let feedback2 = ReviewFeedback {
        outcome: ReviewOutcome::Approved,
        summary: "Second".to_string(),
        comments: Vec::new(),
        session_id: "sess-2".to_string(),
        reviewed_at: "2025-01-02T00:00:00Z".to_string(),
        resolved_from_previous: Vec::new(),
    };
    set_review_feedback(&mut fm, feedback1);
    set_review_feedback(&mut fm, feedback2);
    let pow = fm.proof_of_work.as_ref().unwrap();
    assert_eq!(pow.review_outcome, Some(ReviewOutcome::Approved));
    assert_eq!(pow.review_history.len(), 1);
    assert_eq!(pow.review_history[0].summary, "First");
    assert_eq!(pow.review_feedback.as_ref().unwrap().summary, "Second");
}
