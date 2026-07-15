use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum CancelReason {
    #[default]
    UserStop,
    ForceSend,
    OrgPause,
    ProgrammaticShutdown,
    SessionEviction,
    ModeSwitchAbort,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TurnBoundaryEffect {
    pub keep_pre_turn_cancel_when_idle: bool,
    pub clear_pending_approvals: bool,
    pub persist_cancel_marker: bool,
    pub allow_crash_repair_on_next_turn: bool,
    /// Invalidate messages already enqueued on the backend
    /// `DialogScheduler`. Without this, a queued Send-Now message starts
    /// executing the instant the cancelled turn ends — the "I pressed
    /// Stop but it started again" bug. `false` for ForceSend (the
    /// interrupting message itself is in that queue) and OrgPause
    /// (resume must continue the queued work).
    pub discard_queued_messages: bool,
    /// Fan out cancellation to this session's **background** Delegate/Shadow
    /// workers via their per-job cancel flags. `false` for ForceSend: a
    /// Send-Now interrupt targets only the parent turn — a long-running
    /// background worker must survive a user follow-up message.
    pub cancel_background_workers: bool,
}

impl CancelReason {
    /// Whether a persisted session that is absent from every live runtime
    /// should be crash-repaired to `Failed`. Pausing an org intentionally
    /// enumerates durable member rows, including lazy members that have never
    /// started, so absence is normal for `OrgPause` and must not corrupt them.
    pub const fn repairs_missing_session_as_failed(self) -> bool {
        !matches!(self, Self::OrgPause)
    }

    pub fn boundary_effect(self) -> TurnBoundaryEffect {
        match self {
            Self::UserStop => TurnBoundaryEffect {
                keep_pre_turn_cancel_when_idle: true,
                clear_pending_approvals: true,
                persist_cancel_marker: true,
                allow_crash_repair_on_next_turn: false,
                discard_queued_messages: true,
                cancel_background_workers: true,
            },
            Self::ForceSend => TurnBoundaryEffect {
                keep_pre_turn_cancel_when_idle: false,
                clear_pending_approvals: false,
                persist_cancel_marker: false,
                allow_crash_repair_on_next_turn: false,
                discard_queued_messages: false,
                cancel_background_workers: false,
            },
            Self::OrgPause => TurnBoundaryEffect {
                keep_pre_turn_cancel_when_idle: true,
                clear_pending_approvals: false,
                persist_cancel_marker: false,
                allow_crash_repair_on_next_turn: false,
                discard_queued_messages: false,
                cancel_background_workers: true,
            },
            Self::ProgrammaticShutdown | Self::SessionEviction | Self::ModeSwitchAbort => {
                TurnBoundaryEffect {
                    keep_pre_turn_cancel_when_idle: false,
                    clear_pending_approvals: true,
                    persist_cancel_marker: false,
                    allow_crash_repair_on_next_turn: false,
                    discard_queued_messages: true,
                    cancel_background_workers: true,
                }
            }
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::UserStop => "user_stop",
            Self::ForceSend => "force_send",
            Self::OrgPause => "org_pause",
            Self::ProgrammaticShutdown => "programmatic_shutdown",
            Self::SessionEviction => "session_eviction",
            Self::ModeSwitchAbort => "mode_switch_abort",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::CancelReason;

    #[test]
    fn org_pause_does_not_fail_lazy_persisted_sessions() {
        assert!(!CancelReason::OrgPause.repairs_missing_session_as_failed());
        assert!(CancelReason::UserStop.repairs_missing_session_as_failed());
        assert!(CancelReason::ProgrammaticShutdown.repairs_missing_session_as_failed());
    }
}
