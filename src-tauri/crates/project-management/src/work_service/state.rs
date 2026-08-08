//! Portable WorkItem state machine (`orgtrack/v1` design §9.3).
//!
//! The store still persists the legacy status vocabulary
//! (`backlog`/`planned`/`in_progress`/`in_review`/…) until the UI and CLI
//! switch to the portable states; this module owns the mapping and the
//! transition legality matrix so every mutation path validates against ONE
//! source of truth. Strict enforcement is opt-in per call site
//! (`AtomicServiceOptions::strict_fsm`) — legacy UI paths run in flag-only
//! mode until Phase 7 flips them.

/// Portable states from the frozen v1 contract
/// (`docs/orgtrack-pm-protocol/schemas/common.schema.json`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkItemState {
    Open,
    InProgress,
    Blocked,
    Completed,
    Failed,
    Cancelled,
}

impl WorkItemState {
    pub fn as_str(self) -> &'static str {
        match self {
            WorkItemState::Open => "open",
            WorkItemState::InProgress => "in_progress",
            WorkItemState::Blocked => "blocked",
            WorkItemState::Completed => "completed",
            WorkItemState::Failed => "failed",
            WorkItemState::Cancelled => "cancelled",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "open" => Some(WorkItemState::Open),
            "in_progress" => Some(WorkItemState::InProgress),
            "blocked" => Some(WorkItemState::Blocked),
            "completed" => Some(WorkItemState::Completed),
            "failed" => Some(WorkItemState::Failed),
            "cancelled" => Some(WorkItemState::Cancelled),
            _ => None,
        }
    }
}

/// Map a legacy store status onto the portable state it represents.
///
/// Returns `None` for statuses with no portable meaning (custom user
/// schemes); those bypass FSM validation entirely rather than guessing.
pub fn map_legacy_status(raw: &str) -> Option<WorkItemState> {
    match raw {
        "open" | "backlog" | "planned" => Some(WorkItemState::Open),
        "in_progress" | "in_review" => Some(WorkItemState::InProgress),
        "blocked" => Some(WorkItemState::Blocked),
        "completed" | "done" | "closed" => Some(WorkItemState::Completed),
        "failed" => Some(WorkItemState::Failed),
        "cancelled" | "canceled" | "duplicate" => Some(WorkItemState::Cancelled),
        _ => None,
    }
}

/// Transition legality per design §9.3, including the explicit
/// `in_progress -> open` release edge and the reopen edges.
pub fn is_transition_allowed(from: WorkItemState, to: WorkItemState) -> bool {
    use WorkItemState::*;
    matches!(
        (from, to),
        (Open, InProgress)
            | (Open, Cancelled)
            | (InProgress, Open)
            | (InProgress, Blocked)
            | (InProgress, Completed)
            | (InProgress, Failed)
            | (InProgress, Cancelled)
            | (Blocked, Open)
            | (Blocked, InProgress)
            | (Blocked, Cancelled)
            | (Completed, Open)
            | (Failed, Open)
            | (Failed, Cancelled)
            | (Cancelled, Open)
    )
}

/// Validate a legacy-status change against the portable FSM.
///
/// Relabels within the same portable state (e.g. `backlog -> planned`,
/// `in_progress -> in_review`) are always legal. Changes involving an
/// unmapped custom status are permitted (no portable semantics to
/// enforce). Everything else must be an allowed portable edge.
pub fn validate_legacy_transition(from_raw: &str, to_raw: &str) -> Result<(), String> {
    let (Some(from), Some(to)) = (map_legacy_status(from_raw), map_legacy_status(to_raw)) else {
        return Ok(());
    };
    if from == to {
        return Ok(());
    }
    if is_transition_allowed(from, to) {
        return Ok(());
    }
    Err(format!(
        "portable FSM forbids {} -> {} (mapped from '{}' -> '{}')",
        from.as_str(),
        to.as_str(),
        from_raw,
        to_raw
    ))
}

#[cfg(test)]
mod tests {
    use super::WorkItemState::*;
    use super::*;

    const ALL: [WorkItemState; 6] = [Open, InProgress, Blocked, Completed, Failed, Cancelled];

    #[test]
    fn transition_matrix_matches_contract() {
        let allowed: &[(WorkItemState, WorkItemState)] = &[
            (Open, InProgress),
            (Open, Cancelled),
            (InProgress, Open),
            (InProgress, Blocked),
            (InProgress, Completed),
            (InProgress, Failed),
            (InProgress, Cancelled),
            (Blocked, Open),
            (Blocked, InProgress),
            (Blocked, Cancelled),
            (Completed, Open),
            (Failed, Open),
            (Failed, Cancelled),
            (Cancelled, Open),
        ];
        for from in ALL {
            for to in ALL {
                let expected = allowed.contains(&(from, to));
                assert_eq!(
                    is_transition_allowed(from, to),
                    expected,
                    "{:?} -> {:?}",
                    from,
                    to
                );
            }
        }
    }

    #[test]
    fn no_self_transitions() {
        for state in ALL {
            assert!(!is_transition_allowed(state, state), "{:?}", state);
        }
    }

    #[test]
    fn legacy_relabel_within_same_portable_state_is_legal() {
        assert!(validate_legacy_transition("backlog", "planned").is_ok());
        assert!(validate_legacy_transition("in_progress", "in_review").is_ok());
    }

    #[test]
    fn legacy_reopen_is_legal() {
        assert!(validate_legacy_transition("completed", "backlog").is_ok());
        assert!(validate_legacy_transition("cancelled", "planned").is_ok());
    }

    #[test]
    fn legacy_skip_to_completed_is_flagged() {
        // backlog (open) -> completed skips the claim/in_progress edge.
        assert!(validate_legacy_transition("backlog", "completed").is_err());
        assert!(validate_legacy_transition("completed", "in_review").is_err());
    }

    #[test]
    fn unmapped_custom_statuses_bypass_validation() {
        assert!(validate_legacy_transition("triage", "completed").is_ok());
        assert!(validate_legacy_transition("backlog", "someday").is_ok());
    }

    #[test]
    fn parse_round_trips() {
        for state in ALL {
            assert_eq!(WorkItemState::parse(state.as_str()), Some(state));
        }
        assert_eq!(WorkItemState::parse("in_review"), None);
    }
}
