//! Per-session extraction state + read-only debug snapshot.
//!
//! The mutable struct lives in its own module so the gating helpers
//! (`gating`) and the forked-agent runner (`runner`) are the only crates
//! that can mutate its fields. External callers go through the public
//! `snapshot()` getter or the `is_in_progress` accessor below.

/// Per-session state for memory extraction. Held on `AgentSession`.
#[derive(Debug, Default)]
pub struct ExtractMemoriesState {
    /// Durable start-sequence of the last message processed (cursor).
    /// `None` means no extraction has run yet for this session.
    /// Sequence-anchored so the bounded durable suffix each job loads can
    /// shift without invalidating the cursor.
    pub(super) last_processed_seq: Option<i64>,

    /// True while extraction is in progress (overlap guard).
    pub(super) in_progress: bool,

    /// Turns since last successful extraction (for throttling).
    pub(super) turns_since_extraction: u32,
}

/// Read-only snapshot of [`ExtractMemoriesState`] for debug / E2E endpoints.
///
/// The struct itself keeps its fields private so the per-turn logic is the
/// only thing that can mutate them. Tests need to assert things like
/// "cursor advanced after this turn", so this snapshot exposes the same
/// fields as plain values that can be serialized over HTTP.
#[derive(Debug, Clone, Copy)]
pub struct ExtractMemoriesStateSnapshot {
    pub last_processed_seq: Option<i64>,
    pub in_progress: bool,
    pub turns_since_extraction: u32,
}

impl ExtractMemoriesState {
    /// Return a cheap, read-only snapshot of all gating fields.
    ///
    /// Used by the debug-only `GET /agent/test/em-state/:session_id`
    /// endpoint to prove cross-turn persistence in E2E: the assertion
    /// needs an observable, not just a "behavior should happen" claim.
    pub fn snapshot(&self) -> ExtractMemoriesStateSnapshot {
        ExtractMemoriesStateSnapshot {
            last_processed_seq: self.last_processed_seq,
            in_progress: self.in_progress,
            turns_since_extraction: self.turns_since_extraction,
        }
    }

    /// Accessor for the overlap-guard flag. Only the processor needs
    /// this (to decide whether to stash for a trailing run); the
    /// extractor itself reads the field directly.
    pub fn is_in_progress(&self) -> bool {
        self.in_progress
    }

    /// Clear the overlap-guard flag. Used by the post-turn dispatcher when a
    /// provider build fails before `run_extraction` is reached, so the guard
    /// doesn't stay stuck `true` and block every future extraction.
    pub fn clear_in_progress(&mut self) {
        self.in_progress = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_state_default() {
        let state = ExtractMemoriesState::default();
        assert!(state.last_processed_seq.is_none());
        assert!(!state.in_progress);
        assert_eq!(state.turns_since_extraction, 0);
    }

    #[test]
    fn test_is_in_progress_accessor() {
        let mut state = ExtractMemoriesState::default();
        assert!(!state.is_in_progress());
        state.in_progress = true;
        assert!(state.is_in_progress());
    }
}
