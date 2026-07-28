//! Fire-and-forget hooks used by `org_send_message`: waking idle
//! recipients after an inbox insert (`InboxWakeHook`), and self-aborting
//! the sender's own turn after an accepted shutdown handshake
//! (`SelfAbortHook`). No-op implementations are provided for tests and
//! for org sessions without a runtime `AppState`.

/// Hook the tool calls (fire-and-forget) once an inbox row has been
/// persisted, so that idle or stopped recipient sessions can be woken
/// up to drain their inbox on a fresh background turn.
///
/// The hook receives `(recipient_member_id, org_run_id)` and is expected to:
/// 1. Resolve the recipient member_id to a session_id within the org run.
/// 2. Skip statuses that must not start a second/background turn: running,
///    pending, paused, waiting-for-user, waiting-for-funds, and archived.
/// 3. Otherwise spawn a fresh turn (e.g. via `send_message_impl` with
///    empty content) so the inbox-drain hook on the turn boundary fires.
///
/// The tool itself never blocks on the wake — failures and skips are
/// logged at the hook implementation. The persisted inbox row is the
/// source of truth; if the wake never happens, the row is still drained
/// the next time the recipient session takes a turn.
pub trait InboxWakeHook: Send + Sync {
    fn wake_member(&self, member_id: &str, org_run_id: &str);
}

/// No-op hook — used by tests and by org sessions that don't have a
/// runtime AppState (e.g. the in-memory unit tests in this file).
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopInboxWakeHook;

impl InboxWakeHook for NoopInboxWakeHook {
    fn wake_member(&self, _member_id: &str, _org_run_id: &str) {}
}

/// Hook the tool calls (fire-and-forget) immediately after persisting a
/// `ShutdownResponse{accepted=true}`: the sender (the worker) signals
/// its own runtime to cancel its active turn so it stops doing work
/// while the coordinator processes the acknowledgement.
///
/// We use a hook trait instead of a direct call into `AgentState` so
/// the unit tests can observe the side effect without spinning up a
/// real runtime.
///
/// Failure / no-op behaviour: the persisted inbox row + the
/// coordinator-side drain (which calls `MemberShutdownHook` on the
/// member's runtime as a second safety net) ensure shutdown still
/// converges if this self-abort silently skips. The hook is therefore
/// best-effort by design.
pub trait SelfAbortHook: Send + Sync {
    /// Cancel the sender's own member session after a `shutdown_response`
    /// (`accepted=true`) has been persisted to the coordinator's inbox.
    fn abort_self(&self, sender_member_id: &str, org_run_id: &str);
}

#[derive(Debug, Default, Clone, Copy)]
pub struct NoopSelfAbortHook;

impl SelfAbortHook for NoopSelfAbortHook {
    fn abort_self(&self, _sender_member_id: &str, _org_run_id: &str) {}
}
