//! Scope selector and service options threaded through the atomic RMW
//! choke point.

#[derive(Debug, Clone, Copy)]
pub(super) enum AtomicWorkItemScope<'a> {
    Project(&'a str),
    Standalone { org_id: &'a str },
}

/// Work-service options threaded into the atomic RMW choke point
/// (`orgtrack/v1` Phase 2a). Legacy callers use `Default` — no OCC
/// precondition, flag-only FSM validation, generic `work.patch` audit
/// label. The application service (`crate::work_service`) passes explicit
/// options for strict transitions.
#[derive(Default)]
pub struct AtomicServiceOptions {
    /// Optimistic concurrency: reject with `PM_ERR:REVISION_CONFLICT`
    /// when the row's `local_version` differs before the mutator runs.
    pub expected_local_version: Option<i64>,
    /// Canonical operation label for the audit event (default `work.patch`).
    pub operation: Option<&'static str>,
    /// Reject portable-FSM violations instead of recording them as
    /// flagged audit metadata.
    pub strict_fsm: bool,
    /// Human-supplied reason (transition/reopen/release), audited.
    pub reason: Option<String>,
}
