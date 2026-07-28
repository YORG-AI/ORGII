//! Mid-turn continuation policy: auto-continue nudges and the stale-todo
//! reminder cadence.
//!
//! Extracted from `execute_turn` to keep the main loop body focused on
//! control flow. Both gates are pure predicates over turn-loop counters, so
//! the policy is unit-testable without driving the loop end-to-end.

// ============================================
// Auto-continue (feature-gated, default off)
// ============================================

/// Hard cap on auto-continue nudges per turn. Mirrors Claude Code's
/// TOKEN_BUDGET auto-continue semantics (also feature-gated, default off).
pub(super) const MAX_AUTO_CONTINUATIONS: u32 = 3;
/// Minimum output tokens a continuation must have produced for the next
/// nudge to be worth sending — below this the model is spinning without
/// real progress (diminishing returns), so we let the turn end.
const AUTO_CONTINUE_MIN_PROGRESS_TOKENS: i64 = 500;
/// Context-window fill (percent) at or above which auto-continue defers to
/// the model's own wrap-up. Matches the `error` tier in
/// `context_accounting::ContextUsageSnapshot::warning_level` — at ≥90% the
/// model closing out the turn is the *correct* behavior.
const AUTO_CONTINUE_MAX_CONTEXT_PERCENT: f64 = 90.0;

/// Iterations without a `manage_todo` call before the mid-turn stale-todo
/// reminder fires, and the minimum spacing between two reminders. Both
/// thresholds mirror the reference harness (10 assistant messages since the
/// last TodoWrite, 10 since the previous reminder).
const STALE_TODO_ITERATIONS: u32 = 10;

/// Anti-rush reassurance thresholds: only large-window models (≥1M tokens)
/// past this fill percentage get the "no need to rush" reminder — smaller
/// windows go through the normal budget-nudge path instead.
pub(super) const ANTI_RUSH_MIN_WINDOW: i64 = 1_000_000;
pub(super) const ANTI_RUSH_MIN_PERCENT: f64 = 25.0;

/// Dual-counter gate for the mid-turn stale-todo reminder: enough silence
/// since the last `manage_todo` call AND enough spacing since the previous
/// reminder. Pure so the trigger arithmetic is unit-testable.
pub(super) fn should_inject_todo_reminder(since_todo_use: u32, since_reminder: u32) -> bool {
    since_todo_use >= STALE_TODO_ITERATIONS && since_reminder >= STALE_TODO_ITERATIONS
}

/// Decide whether the turn loop should inject an auto-continue nudge instead
/// of letting the model end the turn with plain text.
///
/// Pure predicate so the policy is unit-testable without driving the loop:
/// - `enabled`: the per-turn feature gate (`TurnConfig::auto_continue`).
/// - `continuations`: nudges already burned this turn (cap: 3).
/// - `last_progress_tokens`: output tokens produced since the previous
///   nudge (`None` when no nudge fired yet). Below 500 → diminishing
///   returns, give up.
/// - `context_percent`: real context-window fill from the last provider
///   response (`None` when unknown → fail closed, let the turn end).
pub(super) fn should_auto_continue(
    enabled: bool,
    continuations: u32,
    last_progress_tokens: Option<i64>,
    context_percent: Option<f64>,
) -> bool {
    if !enabled {
        return false;
    }
    if continuations >= MAX_AUTO_CONTINUATIONS {
        return false;
    }
    // Unknown fill level → we cannot prove the model is stopping early.
    // Fail closed (simple mechanism, no LLM judge): let the turn end.
    let Some(percent) = context_percent else {
        return false;
    };
    if percent >= AUTO_CONTINUE_MAX_CONTEXT_PERCENT {
        return false;
    }
    if let Some(progress) = last_progress_tokens {
        if progress < AUTO_CONTINUE_MIN_PROGRESS_TOKENS {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod stale_todo_reminder_tests {
    use super::{should_inject_todo_reminder, STALE_TODO_ITERATIONS};

    #[test]
    fn fires_only_after_both_counters_reach_threshold() {
        // Fresh turn: nothing due.
        assert!(!should_inject_todo_reminder(0, 0));
        // Silence since last call, but a reminder fired recently → throttled.
        assert!(!should_inject_todo_reminder(STALE_TODO_ITERATIONS + 5, 3));
        // Reminder spacing satisfied, but the model used manage_todo recently.
        assert!(!should_inject_todo_reminder(2, STALE_TODO_ITERATIONS + 5));
        // Both thresholds met → due.
        assert!(should_inject_todo_reminder(
            STALE_TODO_ITERATIONS,
            STALE_TODO_ITERATIONS
        ));
    }

    #[test]
    fn long_run_naggs_roughly_every_threshold_iterations() {
        // Simulate a 30-iteration run that never touches manage_todo:
        // reminders land at iterations 10, 20, 30 — CC's observed cadence.
        let mut since_use = 0u32;
        let mut since_reminder = 0u32;
        let mut fired_at = Vec::new();
        for iteration in 1..=30u32 {
            since_use += 1;
            since_reminder += 1;
            if should_inject_todo_reminder(since_use, since_reminder) {
                since_reminder = 0;
                fired_at.push(iteration);
            }
        }
        assert_eq!(fired_at, vec![10, 20, 30]);
    }
}

#[cfg(test)]
mod auto_continue_tests {
    use super::{should_auto_continue, MAX_AUTO_CONTINUATIONS};

    #[test]
    fn disabled_never_continues() {
        // Feature gate off → never continue, even under ideal conditions.
        assert!(!should_auto_continue(false, 0, None, Some(10.0)));
    }

    #[test]
    fn enabled_below_threshold_continues() {
        // First nudge, plenty of context room, no prior progress data.
        assert!(should_auto_continue(true, 0, None, Some(42.0)));
        // Just below the 90% boundary still continues.
        assert!(should_auto_continue(true, 0, None, Some(89.9)));
    }

    #[test]
    fn context_at_or_above_90_percent_stops() {
        // At ≥90% the model wrapping up is the correct behavior.
        assert!(!should_auto_continue(true, 0, None, Some(90.0)));
        assert!(!should_auto_continue(true, 0, None, Some(97.5)));
    }

    #[test]
    fn unknown_context_fill_fails_closed() {
        // No snapshot / unknown window → cannot prove early stop → end turn.
        assert!(!should_auto_continue(true, 0, None, None));
    }

    #[test]
    fn continuation_cap_stops() {
        assert!(should_auto_continue(
            true,
            MAX_AUTO_CONTINUATIONS - 1,
            Some(5_000),
            Some(30.0)
        ));
        assert!(!should_auto_continue(
            true,
            MAX_AUTO_CONTINUATIONS,
            Some(5_000),
            Some(30.0)
        ));
    }

    #[test]
    fn diminishing_returns_stops() {
        // Previous nudge produced < 500 output tokens → give up.
        assert!(!should_auto_continue(true, 1, Some(499), Some(30.0)));
        assert!(!should_auto_continue(true, 1, Some(0), Some(30.0)));
        // Real progress since the last nudge → keep going.
        assert!(should_auto_continue(true, 1, Some(500), Some(30.0)));
    }
}
