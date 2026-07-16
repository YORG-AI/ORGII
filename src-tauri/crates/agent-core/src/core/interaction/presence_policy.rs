//! Presence policy — single chokepoint mapping a `UserPresence` wire
//! snapshot to runtime behavior.
//!
//! Every consumer (question auto-resolve, plan auto-approve, goal loop,
//! prompt stance rendering) reads `PresencePolicy` fields. Nothing else
//! in the codebase may match on the presence mode string: the wire
//! carries the resolved policy numbers from the frontend's mode spec, so
//! a brand-new custom mode ("angry", "vacation", …) gets full runtime
//! behavior with zero backend changes.
//!
//! Old wire payloads (or third-party callers) that ship only `mode` are
//! still honored: missing fields fall back to the built-in defaults for
//! the three well-known mode ids, and to conservative interactive/off
//! for anything unknown.

use std::time::Duration;

use crate::session::{presence_mode_ids, PresenceStance, UserPresence};

/// Whether (and when) a pending blocking interaction is auto-resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoResolve {
    /// Never auto-resolve — wait for the user indefinitely.
    Off,
    /// Auto-resolve after the given window.
    After(Duration),
}

impl AutoResolve {
    fn from_secs(secs: u32) -> Self {
        if secs == 0 {
            AutoResolve::Off
        } else {
            AutoResolve::After(Duration::from_secs(secs as u64))
        }
    }

    pub fn duration(&self) -> Option<Duration> {
        match self {
            AutoResolve::Off => None,
            AutoResolve::After(duration) => Some(*duration),
        }
    }
}

/// Goal continuation loop policy (Ralph loop).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalLoopPolicy {
    Off,
    On { max_turns: u32 },
}

impl GoalLoopPolicy {
    fn from_max_turns(max_turns: u32) -> Self {
        if max_turns == 0 {
            GoalLoopPolicy::Off
        } else {
            GoalLoopPolicy::On { max_turns }
        }
    }

    pub fn max_turns(&self) -> Option<u32> {
        match self {
            GoalLoopPolicy::Off => None,
            GoalLoopPolicy::On { max_turns } => Some(*max_turns),
        }
    }
}

/// Resolved runtime behavior for the current presence. All consumers
/// read these fields; none re-derive behavior from the mode string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PresencePolicy {
    pub question_auto_resolve: AutoResolve,
    pub plan_auto_approve: AutoResolve,
    pub mode_switch_auto_plan: bool,
    pub goal_loop: GoalLoopPolicy,
    pub prompt_stance: PresenceStance,
}

impl Default for PresencePolicy {
    /// No presence info at all ⇒ behave exactly like Online today.
    fn default() -> Self {
        Self {
            question_auto_resolve: AutoResolve::Off,
            plan_auto_approve: AutoResolve::Off,
            mode_switch_auto_plan: false,
            goal_loop: GoalLoopPolicy::Off,
            prompt_stance: PresenceStance::Interactive,
        }
    }
}

/// Built-in defaults per well-known mode id, used when the wire payload
/// predates the spec redesign (mode only, no policy fields). Mirrors
/// `BUILT_IN_PRESENCE_POLICY` in `src/types/userPresence.ts`.
fn built_in_defaults(mode: &str) -> (PresenceStance, u32, u32, bool, u32) {
    match mode {
        presence_mode_ids::AWAY => (PresenceStance::DeferAndBatch, 180, 0, false, 0),
        presence_mode_ids::INVISIBLE => (PresenceStance::Autonomous, 30, 120, false, 20),
        // Online and any unknown/custom mode without explicit fields:
        // conservative interactive, nothing auto-resolves.
        _ => (PresenceStance::Interactive, 0, 0, false, 0),
    }
}

impl PresencePolicy {
    /// Resolve the policy from a wire snapshot. Explicit wire fields win;
    /// missing fields fall back to built-in defaults for the mode id.
    pub fn resolve(presence: &UserPresence) -> Self {
        let (
            default_stance,
            default_question,
            default_plan,
            default_mode_switch_auto_plan,
            default_goal,
        ) = built_in_defaults(&presence.mode);

        Self {
            question_auto_resolve: AutoResolve::from_secs(
                presence
                    .question_auto_resolve_secs
                    .unwrap_or(default_question),
            ),
            plan_auto_approve: AutoResolve::from_secs(
                presence.plan_auto_approve_secs.unwrap_or(default_plan),
            ),
            mode_switch_auto_plan: presence
                .mode_switch_auto_plan
                .unwrap_or(default_mode_switch_auto_plan),
            goal_loop: GoalLoopPolicy::from_max_turns(
                presence.goal_max_turns.unwrap_or(default_goal),
            ),
            prompt_stance: presence.stance.unwrap_or(default_stance),
        }
    }

    /// Resolve from an optional snapshot — `None` means "no presence
    /// shipped", which behaves like Online.
    pub fn resolve_opt(presence: Option<&UserPresence>) -> Self {
        presence.map(Self::resolve).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire(mode: &str) -> UserPresence {
        UserPresence {
            mode: mode.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn explicit_wire_fields_win_over_mode_defaults() {
        let presence = UserPresence {
            mode: "role:angry".to_string(),
            label: Some("Angry".to_string()),
            stance: Some(PresenceStance::Autonomous),
            question_auto_resolve_secs: Some(15),
            plan_auto_approve_secs: Some(0),
            mode_switch_auto_plan: Some(true),
            goal_max_turns: Some(2),
            ..Default::default()
        };
        let policy = PresencePolicy::resolve(&presence);
        assert_eq!(policy.prompt_stance, PresenceStance::Autonomous);
        assert_eq!(
            policy.question_auto_resolve,
            AutoResolve::After(Duration::from_secs(15))
        );
        assert_eq!(policy.plan_auto_approve, AutoResolve::Off);
        assert!(policy.mode_switch_auto_plan);
        assert_eq!(policy.goal_loop, GoalLoopPolicy::On { max_turns: 2 });
    }

    #[test]
    fn legacy_payload_online_maps_to_interactive_off() {
        let policy = PresencePolicy::resolve(&wire("online"));
        assert_eq!(policy, PresencePolicy::default());
    }

    #[test]
    fn legacy_payload_defaults_to_mode_switch_auto_skip() {
        let policy = PresencePolicy::resolve(&wire("invisible"));
        assert!(!policy.mode_switch_auto_plan);
    }

    #[test]
    fn legacy_payload_invisible_maps_to_goal_mode_defaults() {
        let policy = PresencePolicy::resolve(&wire("invisible"));
        assert_eq!(policy.prompt_stance, PresenceStance::Autonomous);
        assert_eq!(
            policy.question_auto_resolve,
            AutoResolve::After(Duration::from_secs(30))
        );
        assert_eq!(
            policy.plan_auto_approve,
            AutoResolve::After(Duration::from_secs(120))
        );
        assert_eq!(policy.goal_loop, GoalLoopPolicy::On { max_turns: 20 });
    }

    #[test]
    fn legacy_payload_away_maps_to_defer_and_batch() {
        let policy = PresencePolicy::resolve(&wire("away"));
        assert_eq!(policy.prompt_stance, PresenceStance::DeferAndBatch);
        assert_eq!(
            policy.question_auto_resolve,
            AutoResolve::After(Duration::from_secs(180))
        );
        assert_eq!(policy.plan_auto_approve, AutoResolve::Off);
        assert_eq!(policy.goal_loop, GoalLoopPolicy::Off);
    }

    #[test]
    fn unknown_custom_mode_without_fields_is_conservative() {
        let policy = PresencePolicy::resolve(&wire("role:mystery"));
        assert_eq!(policy, PresencePolicy::default());
    }

    #[test]
    fn zero_values_mean_off() {
        let presence = UserPresence {
            mode: "invisible".to_string(),
            stance: Some(PresenceStance::Autonomous),
            question_auto_resolve_secs: Some(0),
            plan_auto_approve_secs: Some(0),
            goal_max_turns: Some(0),
            ..Default::default()
        };
        let policy = PresencePolicy::resolve(&presence);
        assert_eq!(policy.question_auto_resolve, AutoResolve::Off);
        assert_eq!(policy.plan_auto_approve, AutoResolve::Off);
        assert_eq!(policy.goal_loop, GoalLoopPolicy::Off);
    }

    #[test]
    fn no_presence_behaves_like_online() {
        assert_eq!(PresencePolicy::resolve_opt(None), PresencePolicy::default());
    }
}
