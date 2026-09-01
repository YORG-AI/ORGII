//! Post-turn background-work gate.
//!
//! Single pure predicate deciding whether the post-turn background jobs
//! (session memory extraction, extract-memories, auto-dream) may run.

use crate::core::session::types::DialogTurnState;

/// Pure helper: should post-turn background work (session memory extraction,
/// extract-memories, auto-dream) run for this turn?
///
/// These tasks are skipped whenever the turn was cancelled by the user — they
/// consume LLM tokens summarizing a turn the user explicitly stopped, and
/// racing with lifecycle teardown can surface as unhandled promise rejections
/// on the frontend. No synthetic/background work should outlive an
/// explicit cancel.
#[inline]
pub(crate) fn should_run_post_turn_work(
    feature_enabled: bool,
    final_turn_state: DialogTurnState,
) -> bool {
    feature_enabled && final_turn_state != DialogTurnState::Cancelled
}

#[cfg(test)]
mod post_turn_work_tests {
    use super::*;

    #[test]
    fn runs_when_enabled_and_completed() {
        assert!(should_run_post_turn_work(true, DialogTurnState::Completed));
    }

    #[test]
    fn skips_when_cancelled_even_if_enabled() {
        assert!(!should_run_post_turn_work(true, DialogTurnState::Cancelled));
    }

    #[test]
    fn skips_when_feature_disabled() {
        assert!(!should_run_post_turn_work(
            false,
            DialogTurnState::Completed
        ));
        assert!(!should_run_post_turn_work(
            false,
            DialogTurnState::Cancelled
        ));
    }
}
