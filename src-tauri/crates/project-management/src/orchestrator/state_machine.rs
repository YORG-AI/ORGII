//! Orchestrator state machine — phase transitions and config snapshots.
//!
//! The orchestrator reads `orchestrator_state` from a work item's frontmatter,
//! applies deterministic transition rules using `active_config`, writes the
//! updated state back atomically, and triggers the next action (launch session,
//! update status, etc.).

use crate::projects::io;
use crate::projects::types::{
    AgentRole, LastFailure, LinkedSession, LinkedSessionStatus, LinkedSessionType,
    OrchestratorConfig, OrchestratorPhase, OrchestratorState, ReviewOutcome, WorkItemFrontmatter,
};
use core_types::session::PENDING_SESSION_PLACEHOLDER;

/// Project the active workflow phase onto non-terminal Work Item status.
/// A workflow/Run reaching `Completed` never completes product intent; closing
/// the Work Item remains an explicit work transition.
fn auto_transition_status(frontmatter: &mut WorkItemFrontmatter, phase: &OrchestratorPhase) {
    let new_status = match phase {
        OrchestratorPhase::Coding => "in_progress",
        OrchestratorPhase::Review => "in_review",
        OrchestratorPhase::Completed => return,
        OrchestratorPhase::AwaitingUser => "in_review",
        // Failed and Idle don't change status (keep in_progress for failed)
        _ => return,
    };
    frontmatter.status = new_status.to_string();
}

/// Snapshot the current `orchestrator_config` into `orchestrator_state.active_config`.
/// Called once when transitioning from idle → coding.
pub fn snapshot_config(frontmatter: &mut WorkItemFrontmatter) {
    let config = frontmatter.orchestrator_config.clone().unwrap_or_default();

    let state = frontmatter
        .orchestrator_state
        .get_or_insert_with(OrchestratorState::default);

    state.active_config = Some(config);
    state.current_phase = OrchestratorPhase::Coding;
    state.retry_count = 0;
    state.review_round = 0;
    state.interrupted = false;
    state.interrupted_phase = None;
    state.last_failure = None;

    auto_transition_status(frontmatter, &OrchestratorPhase::Coding);
}

/// Resolve the effective config: active_config if running, else orchestrator_config.
pub fn effective_config(frontmatter: &WorkItemFrontmatter) -> OrchestratorConfig {
    frontmatter
        .orchestrator_state
        .as_ref()
        .and_then(|state| state.active_config.clone())
        .unwrap_or_else(|| frontmatter.orchestrator_config.clone().unwrap_or_default())
}

/// Transition after agent session completes successfully.
pub fn on_session_complete(frontmatter: &mut WorkItemFrontmatter) -> TransitionResult {
    let config = effective_config(frontmatter);
    let state = frontmatter
        .orchestrator_state
        .get_or_insert_with(OrchestratorState::default);

    if config.effective_review_config().is_some() {
        state.current_phase = OrchestratorPhase::Review;
        auto_transition_status(frontmatter, &OrchestratorPhase::Review);
        add_linked_session(
            frontmatter,
            "pending",
            AgentRole::Review,
            LinkedSessionType::Native,
        );
        TransitionResult::LaunchReview
    } else {
        state.current_phase = OrchestratorPhase::Completed;
        state.active_config = None;
        auto_transition_status(frontmatter, &OrchestratorPhase::Completed);
        TransitionResult::Completed
    }
}

/// Transition after agent session fails.
pub fn on_session_failed(
    frontmatter: &mut WorkItemFrontmatter,
    session_id: &str,
    reason: &str,
) -> TransitionResult {
    let config = effective_config(frontmatter);
    let state = frontmatter
        .orchestrator_state
        .get_or_insert_with(OrchestratorState::default);

    state.last_failure = Some(LastFailure {
        session_id: Some(session_id.to_string()),
        reason: Some(reason.to_string()),
        timestamp: Some(chrono::Utc::now().to_rfc3339()),
    });

    if config.auto_retry_on_failure && state.retry_count < config.max_retry_count {
        state.retry_count += 1;
        state.current_phase = OrchestratorPhase::Coding;
        TransitionResult::RetryAgent
    } else {
        state.current_phase = OrchestratorPhase::Failed;
        TransitionResult::Failed
    }
}

/// Transition after review completes (agent or human).
///
/// - `Approved` → Completed
/// - `ChangesRequested` → back to Coding (fix round) if under max_rounds, else AwaitingUser
/// - `Inconclusive` → AwaitingUser
pub fn on_review_complete(
    frontmatter: &mut WorkItemFrontmatter,
    outcome: &ReviewOutcome,
) -> TransitionResult {
    let config = effective_config(frontmatter);
    let review_config = config.effective_review_config();
    let max_rounds = review_config.as_ref().map_or(3, |rc| rc.max_rounds);

    let state = frontmatter
        .orchestrator_state
        .get_or_insert_with(OrchestratorState::default);

    match outcome {
        ReviewOutcome::Approved => {
            state.current_phase = OrchestratorPhase::Completed;
            state.active_config = None;
            auto_transition_status(frontmatter, &OrchestratorPhase::Completed);
            TransitionResult::Completed
        }
        ReviewOutcome::ChangesRequested => {
            if state.review_round < max_rounds {
                state.review_round += 1;
                state.current_phase = OrchestratorPhase::Coding;
                auto_transition_status(frontmatter, &OrchestratorPhase::Coding);
                add_linked_session(
                    frontmatter,
                    "pending",
                    AgentRole::Coding,
                    LinkedSessionType::Native,
                );
                TransitionResult::LaunchFix
            } else {
                state.current_phase = OrchestratorPhase::AwaitingUser;
                auto_transition_status(frontmatter, &OrchestratorPhase::AwaitingUser);
                TransitionResult::AwaitingUser
            }
        }
        ReviewOutcome::Inconclusive => {
            state.current_phase = OrchestratorPhase::AwaitingUser;
            auto_transition_status(frontmatter, &OrchestratorPhase::AwaitingUser);
            TransitionResult::AwaitingUser
        }
    }
}

/// Transition after review agent fails (e.g. LLM error, timeout).
pub fn on_review_failed(
    frontmatter: &mut WorkItemFrontmatter,
    session_id: &str,
    reason: &str,
) -> TransitionResult {
    let state = frontmatter
        .orchestrator_state
        .get_or_insert_with(OrchestratorState::default);

    state.last_failure = Some(LastFailure {
        session_id: Some(session_id.to_string()),
        reason: Some(reason.to_string()),
        timestamp: Some(chrono::Utc::now().to_rfc3339()),
    });
    state.current_phase = OrchestratorPhase::AwaitingUser;

    TransitionResult::AwaitingUser
}

/// Mark the workflow as interrupted (graceful shutdown).
pub fn mark_interrupted(frontmatter: &mut WorkItemFrontmatter) {
    let state = frontmatter
        .orchestrator_state
        .get_or_insert_with(OrchestratorState::default);

    state.interrupted_phase = Some(state.current_phase.clone());
    state.interrupted = true;
}

/// Cancel the workflow — reset to idle and mark all running linked sessions
/// as cancelled so the frontend doesn't show stale "running" entries.
pub fn cancel(frontmatter: &mut WorkItemFrontmatter) {
    let state = frontmatter
        .orchestrator_state
        .get_or_insert_with(OrchestratorState::default);

    state.current_phase = OrchestratorPhase::Idle;
    state.active_config = None;
    state.interrupted = false;
    state.interrupted_phase = None;

    let now = chrono::Utc::now().to_rfc3339();
    for session in &mut frontmatter.linked_sessions {
        if session.status == LinkedSessionStatus::Running {
            session.status = LinkedSessionStatus::Cancelled;
            session.completed_at = Some(now.clone());
        }
    }
    frontmatter.execution_lock = None;
}

/// Add a linked session record to the work item.
pub fn add_linked_session(
    frontmatter: &mut WorkItemFrontmatter,
    session_id: &str,
    agent_role: AgentRole,
    session_type: LinkedSessionType,
) {
    frontmatter.linked_sessions.push(LinkedSession {
        session_id: session_id.to_string(),
        session_type,
        agent_role,
        started_at: chrono::Utc::now().to_rfc3339(),
        completed_at: None,
        status: LinkedSessionStatus::Running,
        cost_usd: 0.0,
        total_tokens: 0,
        parent_session_id: None,
        sub_agent_name: None,
        sub_agent_instance: None,
        result_preview: None,
    });
}

/// Update a linked session's status and timestamps, and accumulate cost.
///
/// Matches by exact `session_id` first. If no match is found, falls back to
/// the most recent `"pending"` entry still in `Running` status — this covers
/// the edge case where the pending→real-ID replacement was silently dropped.
pub fn complete_linked_session(
    frontmatter: &mut WorkItemFrontmatter,
    session_id: &str,
    status: LinkedSessionStatus,
    cost_usd: f64,
    total_tokens: u64,
) {
    let idx = frontmatter
        .linked_sessions
        .iter()
        .rposition(|ls| ls.session_id == session_id && ls.status == LinkedSessionStatus::Running)
        .or_else(|| {
            frontmatter
                .linked_sessions
                .iter()
                .rposition(|ls| ls.session_id == session_id)
        })
        .or_else(|| {
            tracing::warn!(
                "[state_machine] No linked session for '{}', falling back to pending placeholder",
                session_id
            );
            frontmatter.linked_sessions.iter().rposition(|ls| {
                ls.session_id == PENDING_SESSION_PLACEHOLDER
                    && ls.status == LinkedSessionStatus::Running
            })
        });

    if let Some(idx) = idx {
        let session = &mut frontmatter.linked_sessions[idx];
        session.session_id = session_id.to_string();
        session.status = status;
        session.completed_at = Some(chrono::Utc::now().to_rfc3339());
        session.cost_usd = cost_usd;
        session.total_tokens = total_tokens;
    }

    if frontmatter
        .execution_lock
        .as_ref()
        .and_then(|lock| lock.active_session_id.as_deref())
        == Some(session_id)
    {
        frontmatter.execution_lock = None;
    }

    // Accumulate into proof_of_work totals
    super::proof_of_work::accumulate_cost(frontmatter, cost_usd, total_tokens);
}

/// Read a work item, apply a mutation, and write it back atomically.
///
/// `update_work_item_atomic` opens a `BEGIN IMMEDIATE` transaction on
/// `projects.db`, locks the row, runs the mutator on the deserialized
/// frontmatter (orchestrator state and linked sessions included — they
/// live in `workitem_extras.extras_json`), and commits the reserialized
/// blob. This wrapper just bumps `updated_at` after the mutator runs.
pub fn mutate_work_item(
    project_slug: &str,
    short_id: &str,
    mutator: impl FnOnce(&mut WorkItemFrontmatter) -> TransitionResult,
) -> Result<TransitionResult, String> {
    // Session terminal handling advances workflow state and proof metadata;
    // it is not Work Item completion. Any terminal product status is written
    // through an explicit user/agent work.transition command.
    let service = io::AtomicServiceOptions {
        operation: Some("work.transition"),
        reason: Some("workflow phase: orchestrator session terminal".to_string()),
        ..Default::default()
    };
    io::update_work_item_atomic_serviced(
        project_slug,
        short_id,
        None,
        service,
        |frontmatter, _body| {
            let result = mutator(frontmatter);
            frontmatter.updated_at = chrono::Utc::now().to_rfc3339();
            Ok(result)
        },
    )
}

/// What action the orchestrator should take after a transition.
#[derive(Debug, Clone, PartialEq)]
pub enum TransitionResult {
    LaunchReview,
    /// Review gave ChangesRequested — re-launch owner agent with review feedback.
    LaunchFix,
    RetryAgent,
    Completed,
    Failed,
    CreateFollowUp,
    AwaitingUser,
    /// Stale terminal signal from a session that no longer owns the
    /// item's execution claim — the mutation was skipped entirely.
    Ignored,
}
