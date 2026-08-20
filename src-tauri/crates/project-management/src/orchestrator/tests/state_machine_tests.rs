use crate::orchestrator::state_machine::*;
use crate::projects::types::*;

fn make_frontmatter() -> WorkItemFrontmatter {
    WorkItemFrontmatter {
        id: "test-id".to_string(),
        short_id: "TST-001".to_string(),
        title: "Test item".to_string(),
        project: None,
        status: "open".to_string(),
        priority: "medium".to_string(),
        assignee: None,
        assignee_type: None,
        labels: vec![],
        milestone: None,
        parent: None,
        stage: None,
        start_date: None,
        target_date: None,
        created_by: None,
        origin_session: None,
        created_at: "2024-01-01T00:00:00Z".to_string(),
        updated_at: "2024-01-01T00:00:00Z".to_string(),
        deleted_at: None,
        starred: false,
        todos: vec![],
        comments: vec![],
        history: vec![],
        delegations: vec![],
        linked_sessions: vec![],
        handoff: None,
        proof_of_work: None,
        orchestrator_config: None,
        orchestrator_state: None,
        follow_up_items: vec![],
        schedule: None,
        routine_source: None,
        execution_lock: None,
        close_out: None,
        work_products: vec![],
    }
}

// ========== snapshot_config ==========

#[test]
fn snapshot_config_initializes_coding_phase() {
    let mut fm = make_frontmatter();
    fm.orchestrator_config = Some(OrchestratorConfig::default());
    snapshot_config(&mut fm);
    let state = fm.orchestrator_state.as_ref().unwrap();
    assert_eq!(state.current_phase, OrchestratorPhase::Coding);
    assert_eq!(state.retry_count, 0);
    assert_eq!(state.review_round, 0);
    assert!(!state.interrupted);
    assert!(state.active_config.is_some());
    assert_eq!(fm.status, "in_progress");
}

#[test]
fn snapshot_config_uses_default_when_no_config() {
    let mut fm = make_frontmatter();
    snapshot_config(&mut fm);
    let state = fm.orchestrator_state.as_ref().unwrap();
    assert!(state.active_config.is_some());
    assert_eq!(state.current_phase, OrchestratorPhase::Coding);
}

// ========== effective_config ==========

#[test]
fn effective_config_returns_active_when_present() {
    let mut fm = make_frontmatter();
    let config = OrchestratorConfig {
        auto_retry_on_failure: true,
        ..OrchestratorConfig::default()
    };
    fm.orchestrator_state = Some(OrchestratorState {
        active_config: Some(config),
        ..OrchestratorState::default()
    });
    let eff = effective_config(&fm);
    assert!(eff.auto_retry_on_failure);
}

#[test]
fn effective_config_falls_back_to_orchestrator_config() {
    let mut fm = make_frontmatter();
    let config = OrchestratorConfig {
        follow_up_enabled: true,
        ..OrchestratorConfig::default()
    };
    fm.orchestrator_config = Some(config);
    let eff = effective_config(&fm);
    assert!(eff.follow_up_enabled);
}

#[test]
fn effective_config_returns_default_when_none() {
    let fm = make_frontmatter();
    let eff = effective_config(&fm);
    assert!(!eff.auto_retry_on_failure);
    assert!(!eff.follow_up_enabled);
}

// ========== on_session_complete ==========

#[test]
fn on_session_complete_without_review_does_not_complete_work_item() {
    let mut fm = make_frontmatter();
    snapshot_config(&mut fm);
    let result = on_session_complete(&mut fm);
    assert_eq!(result, TransitionResult::Completed);
    let state = fm.orchestrator_state.as_ref().unwrap();
    assert_eq!(state.current_phase, OrchestratorPhase::Completed);
    assert!(state.active_config.is_none());
    assert_eq!(fm.status, "in_progress");
}

#[test]
fn on_session_complete_ignores_review_config() {
    let mut fm = make_frontmatter();
    fm.orchestrator_config = Some(OrchestratorConfig {
        review_enabled: true,
        ..OrchestratorConfig::default()
    });
    snapshot_config(&mut fm);
    let result = on_session_complete(&mut fm);
    assert_eq!(result, TransitionResult::Completed);
    let state = fm.orchestrator_state.as_ref().unwrap();
    assert_eq!(state.current_phase, OrchestratorPhase::Completed);
}

// ========== on_session_failed ==========

#[test]
fn on_session_failed_retries_when_configured() {
    let mut fm = make_frontmatter();
    fm.orchestrator_config = Some(OrchestratorConfig {
        auto_retry_on_failure: true,
        max_retry_count: 3,
        ..OrchestratorConfig::default()
    });
    snapshot_config(&mut fm);
    let result = on_session_failed(&mut fm, "sess-1", "timeout");
    assert_eq!(result, TransitionResult::RetryAgent);
    let state = fm.orchestrator_state.as_ref().unwrap();
    assert_eq!(state.retry_count, 1);
    assert_eq!(state.current_phase, OrchestratorPhase::Coding);
    assert!(state.last_failure.is_some());
}

#[test]
fn on_session_failed_fails_when_retries_exhausted() {
    let mut fm = make_frontmatter();
    fm.orchestrator_config = Some(OrchestratorConfig {
        auto_retry_on_failure: true,
        max_retry_count: 1,
        ..OrchestratorConfig::default()
    });
    snapshot_config(&mut fm);
    let result1 = on_session_failed(&mut fm, "sess-1", "error1");
    assert_eq!(result1, TransitionResult::RetryAgent);
    let result2 = on_session_failed(&mut fm, "sess-2", "error2");
    assert_eq!(result2, TransitionResult::Failed);
    let state = fm.orchestrator_state.as_ref().unwrap();
    assert_eq!(state.current_phase, OrchestratorPhase::Failed);
}

#[test]
fn on_session_failed_fails_immediately_without_retry() {
    let mut fm = make_frontmatter();
    snapshot_config(&mut fm);
    let result = on_session_failed(&mut fm, "sess-1", "crash");
    assert_eq!(result, TransitionResult::Failed);
}

// ========== mark_interrupted ==========

#[test]
fn mark_interrupted_saves_phase() {
    let mut fm = make_frontmatter();
    snapshot_config(&mut fm);
    mark_interrupted(&mut fm);
    let state = fm.orchestrator_state.as_ref().unwrap();
    assert!(state.interrupted);
    assert_eq!(state.interrupted_phase, Some(OrchestratorPhase::Coding));
}

// ========== cancel ==========

#[test]
fn cancel_resets_to_idle() {
    let mut fm = make_frontmatter();
    snapshot_config(&mut fm);
    cancel(&mut fm);
    let state = fm.orchestrator_state.as_ref().unwrap();
    assert_eq!(state.current_phase, OrchestratorPhase::Idle);
    assert!(state.active_config.is_none());
    assert!(!state.interrupted);
}

#[test]
fn cancel_marks_running_sessions_cancelled() {
    let mut fm = make_frontmatter();
    snapshot_config(&mut fm);
    add_linked_session(
        &mut fm,
        "sess-1",
        AgentRole::Coding,
        LinkedSessionType::Native,
    );
    assert_eq!(fm.linked_sessions[0].status, LinkedSessionStatus::Running);
    cancel(&mut fm);
    assert_eq!(fm.linked_sessions[0].status, LinkedSessionStatus::Cancelled);
    assert!(fm.linked_sessions[0].completed_at.is_some());
}

// ========== add_linked_session ==========

#[test]
fn add_linked_session_appends_running_entry() {
    let mut fm = make_frontmatter();
    add_linked_session(
        &mut fm,
        "sess-1",
        AgentRole::Coding,
        LinkedSessionType::Native,
    );
    assert_eq!(fm.linked_sessions.len(), 1);
    assert_eq!(fm.linked_sessions[0].session_id, "sess-1");
    assert_eq!(fm.linked_sessions[0].agent_role, AgentRole::Coding);
    assert_eq!(fm.linked_sessions[0].status, LinkedSessionStatus::Running);
    assert_eq!(fm.linked_sessions[0].cost_usd, 0.0);
}

// ========== complete_linked_session ==========

#[test]
fn complete_linked_session_by_id() {
    let mut fm = make_frontmatter();
    add_linked_session(
        &mut fm,
        "sess-1",
        AgentRole::Coding,
        LinkedSessionType::Native,
    );
    complete_linked_session(
        &mut fm,
        "sess-1",
        LinkedSessionStatus::Completed,
        0.50,
        1000,
    );
    assert_eq!(fm.linked_sessions[0].status, LinkedSessionStatus::Completed);
    assert_eq!(fm.linked_sessions[0].cost_usd, 0.50);
    assert_eq!(fm.linked_sessions[0].total_tokens, 1000);
    assert!(fm.linked_sessions[0].completed_at.is_some());
}

#[test]
fn complete_linked_session_falls_back_to_pending() {
    let mut fm = make_frontmatter();
    add_linked_session(
        &mut fm,
        "pending",
        AgentRole::Coding,
        LinkedSessionType::Native,
    );
    complete_linked_session(
        &mut fm,
        "real-sess-id",
        LinkedSessionStatus::Completed,
        1.0,
        500,
    );
    assert_eq!(fm.linked_sessions[0].session_id, "real-sess-id");
    assert_eq!(fm.linked_sessions[0].status, LinkedSessionStatus::Completed);
}

#[test]
fn complete_linked_session_prefers_latest_running_duplicate() {
    let mut fm = make_frontmatter();
    add_linked_session(
        &mut fm,
        "sess-1",
        AgentRole::Coding,
        LinkedSessionType::Native,
    );
    fm.linked_sessions[0].status = LinkedSessionStatus::Completed;
    add_linked_session(
        &mut fm,
        "sess-1",
        AgentRole::Coding,
        LinkedSessionType::Native,
    );

    complete_linked_session(&mut fm, "sess-1", LinkedSessionStatus::Completed, 0.25, 750);

    assert_eq!(fm.linked_sessions[0].total_tokens, 0);
    assert_eq!(fm.linked_sessions[1].status, LinkedSessionStatus::Completed);
    assert_eq!(fm.linked_sessions[1].total_tokens, 750);
}
