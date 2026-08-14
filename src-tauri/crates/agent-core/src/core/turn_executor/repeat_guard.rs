//! Progress-aware repeated-tool-call guard for the agentic loop.
//!
//! The turn executor breaks the loop when the model keeps emitting the same
//! tool batch. Plain args-identity is the right test for deterministic tools
//! (same args → same result → the model is stuck), but it is a false positive
//! for observation tools whose identical re-invocation is the intended
//! protocol while the observed job advances: `await_output(wait_for, 30s)` on
//! a 2-minute build produces 3 identical calls in ~90s and used to end the
//! turn mid-verification even though every wait returned fresh output.
//!
//! The guard therefore keys its streak on `(signature, fingerprint)`:
//! `signature` is the joined `name:args` of the batch (what the model chose
//! to do), `fingerprint` is the joined [`Tool::progress_fingerprint`] of the
//! batch (what the world looked like when it chose it, probed just before
//! dispatch). An identical signature whose fingerprint moved means the model
//! received new information between the two calls — that is polling, not
//! looping, and the streak resets. An identical signature with an identical
//! fingerprint (or no fingerprint at all — the default for every tool that
//! does not opt in) counts toward [`MAX_REPEAT_STREAK`].
//!
//! [`Tool::progress_fingerprint`]: crate::tools::traits::Tool::progress_fingerprint

use super::backoff::MAX_REPEAT_STREAK;

/// Decision for one observed tool batch, made BEFORE the batch executes.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum RepeatVerdict {
    /// Execute the batch (fresh call, or a repeat that is still under the
    /// streak limit / showed progress).
    Proceed,
    /// Break the turn instead of executing: the same batch was already
    /// executed `executed_attempts` times with nothing new in between.
    /// `progress_aware` is true when the batch carried a fingerprint, i.e.
    /// the calls were observation waits on background jobs rather than a
    /// deterministic tool loop — callers phrase the closure message (and its
    /// recovery story) differently for the two cases.
    Break {
        executed_attempts: u32,
        progress_aware: bool,
    },
}

#[derive(Default)]
pub(super) struct RepeatGuard {
    last_signature: Option<String>,
    last_fingerprint: Option<String>,
    streak: u32,
}

impl RepeatGuard {
    /// Observe the batch the model just emitted. `signature` identifies the
    /// batch by name+args; `fingerprint` is the batch's progress probe
    /// (`None` when no tool in the batch opted in).
    pub(super) fn observe(
        &mut self,
        signature: String,
        fingerprint: Option<String>,
    ) -> RepeatVerdict {
        let same_signature = self.last_signature.as_ref() == Some(&signature);
        let progressed =
            same_signature && fingerprint.is_some() && fingerprint != self.last_fingerprint;

        if same_signature && !progressed {
            self.streak += 1;
        } else {
            self.streak = 0;
        }
        self.last_signature = Some(signature);
        self.last_fingerprint = fingerprint;

        if self.streak >= MAX_REPEAT_STREAK {
            RepeatVerdict::Break {
                executed_attempts: self.streak,
                progress_aware: self.last_fingerprint.is_some(),
            }
        } else {
            RepeatVerdict::Proceed
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sig() -> String {
        "await_output:{\"handles\":[\"46496\"]}".to_string()
    }

    #[test]
    fn identical_calls_without_fingerprint_break_at_streak_limit() {
        let mut guard = RepeatGuard::default();
        assert_eq!(guard.observe(sig(), None), RepeatVerdict::Proceed);
        assert_eq!(guard.observe(sig(), None), RepeatVerdict::Proceed);
        assert_eq!(guard.observe(sig(), None), RepeatVerdict::Proceed);
        assert_eq!(
            guard.observe(sig(), None),
            RepeatVerdict::Break {
                executed_attempts: 3,
                progress_aware: false,
            },
            "4th identical call breaks after 3 executed attempts"
        );
    }

    #[test]
    fn advancing_fingerprint_never_breaks() {
        let mut guard = RepeatGuard::default();
        for cursor in 0..50u32 {
            assert_eq!(
                guard.observe(sig(), Some(format!("46496=running@seq:{cursor}"))),
                RepeatVerdict::Proceed,
                "output advanced before call {cursor} → the model is polling, not looping"
            );
        }
    }

    #[test]
    fn stalled_fingerprint_breaks_and_is_marked_progress_aware() {
        let mut guard = RepeatGuard::default();
        let stalled = || Some("46496=running@seq:7:bytes:787".to_string());
        assert_eq!(guard.observe(sig(), stalled()), RepeatVerdict::Proceed);
        assert_eq!(guard.observe(sig(), stalled()), RepeatVerdict::Proceed);
        assert_eq!(guard.observe(sig(), stalled()), RepeatVerdict::Proceed);
        assert_eq!(
            guard.observe(sig(), stalled()),
            RepeatVerdict::Break {
                executed_attempts: 3,
                progress_aware: true,
            }
        );
    }

    #[test]
    fn progress_resets_an_accumulated_streak() {
        let mut guard = RepeatGuard::default();
        let stalled = || Some("46496=running@seq:1".to_string());
        guard.observe(sig(), stalled());
        guard.observe(sig(), stalled());
        guard.observe(sig(), stalled());
        assert_eq!(
            guard.observe(sig(), Some("46496=running@seq:2".to_string())),
            RepeatVerdict::Proceed,
            "new output on the brink of the limit must clear the streak"
        );
        assert_eq!(
            guard.observe(sig(), Some("46496=running@seq:2".to_string())),
            RepeatVerdict::Proceed,
            "streak restarts from zero after the reset"
        );
    }

    #[test]
    fn different_signature_resets_the_streak() {
        let mut guard = RepeatGuard::default();
        guard.observe(sig(), None);
        guard.observe(sig(), None);
        guard.observe(sig(), None);
        assert_eq!(
            guard.observe("read_file:{\"path\":\"a\"}".to_string(), None),
            RepeatVerdict::Proceed
        );
        assert_eq!(
            guard.observe(sig(), None),
            RepeatVerdict::Proceed,
            "returning to a previous signature is a fresh streak, matching the old behavior"
        );
    }

    #[test]
    fn terminal_fingerprint_reread_still_breaks() {
        let mut guard = RepeatGuard::default();
        guard.observe(sig(), Some("46496=running@seq:9".to_string()));
        assert_eq!(
            guard.observe(sig(), Some("46496=exited:0".to_string())),
            RepeatVerdict::Proceed,
            "termination is progress — the model gets to read the result"
        );
        guard.observe(sig(), Some("46496=exited:0".to_string()));
        guard.observe(sig(), Some("46496=exited:0".to_string()));
        assert_eq!(
            guard.observe(sig(), Some("46496=exited:0".to_string())),
            RepeatVerdict::Break {
                executed_attempts: 3,
                progress_aware: true,
            },
            "re-reading the same terminal result forever is a genuine loop"
        );
    }
}
