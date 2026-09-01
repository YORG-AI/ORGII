//! Unix session-leader registry and the pure sweep-candidate predicates used
//! by the app-exit sweep to reach HUP-immune descendants of removed sessions.

/// Process-global registry of Unix session-leader PIDs (= shell PIDs, since
/// spawn calls `setsid()`) that must be swept on app exit.
///
/// Deliberately a process-global static, not a field on `PtyState`: a shell's
/// PID must remain sweepable AFTER its `PtySession` leaves the sessions map,
/// which happens in two paths that both predate app exit — the reader's
/// natural-EOF removal (shell exited, e.g. right after launching a backgrounded
/// `nohup` job) and `close_session` (user closed the tab). In both cases the
/// shell PID vanishes from the map, but HUP-immune descendants in its session
/// keep running until logout. Only the app-exit sweep is contracted to kill
/// them, so the SID must outlive the session.
///
/// Reached from `create_session` — where both creation paths (the user-facing
/// `create_pty` command and the OS-agent path) converge and where neither
/// agent call site has access to `PtyState` — by a single insert, and
/// consumed by `shutdown_kill_all`. PTY cleanup is inherently process-global
/// (one app process owns one set of descendants to sweep), so a static carries
/// no isolation risk that `PtyState`'s Tauri-managed singleton would not.
///
/// Lifetime: entries are added at shell spawn and removed only by the
/// app-exit sweep (`shutdown_kill_all` clears the whole registry). There is
/// intentionally NO `unregister` on natural session removal — removing an
/// entry the moment its shell exits would discard exactly the SID needed to
/// sweep that shell's still-living HUP-immune descendants, reintroducing the
/// leak this registry exists to close. A safe unregister would require
/// proving no live descendants remain, which cannot be done without a
/// process scan at removal time. Entries are 12 bytes each and bounded by
/// the app's lifetime terminal churn, so unbounded growth is not a concern.
///
/// Each entry pairs the PID with the shell's `start_time` (seconds since
/// boot). On app-exit sweep, a registered PID is treated as a sweep candidate
/// only if its current holder either no longer exists (shell dead, PID not
/// reused — its orphaned descendants are safe to sweep) or still has the
/// recorded `start_time` (our shell is still alive). If the PID now exists
/// with a different `start_time`, the OS reused it for an unrelated process
/// and we drop the candidate rather than risk killing the wrong session.
/// This closes the most direct PID-reuse mis-kill path; it is NOT a complete
/// proof — see [`shutdown_kill_all`] for the residual window.
#[cfg(unix)]
pub(super) fn pending_exit_session_leaders(
) -> &'static std::sync::Mutex<std::collections::HashMap<u32, u64>> {
    static REGISTRY: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<u32, u64>>> =
        std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Record a spawned shell's PID (== Unix session-leader id) together with its
/// `start_time`, so the app-exit sweep can still find its descendants after
/// the session leaves the map AND can tell the shell apart from a later
/// PID-reuse holder. `start_time` is seconds since boot (sysinfo convention);
/// callers obtain it from a fresh `System` snapshot taken immediately after
/// spawn so it reflects this shell, not a racing reuse.
#[cfg(unix)]
pub(crate) fn register_session_leader(pid: u32, start_time: u64) {
    if let Ok(mut reg) = pending_exit_session_leaders().lock() {
        reg.insert(pid, start_time);
    }
}

/// Decide whether a registered session leader is still a safe sweep
/// candidate given its current holder. Pure (no I/O) so it is unit-testable.
///
/// - `None` → the PID has no current holder: our shell died without the PID
///   being reused, so its orphaned descendants (still reporting `SID = pid`)
///   are safe to sweep.
/// - `Some(holder_start)` → the PID exists. If `holder_start` matches the
///   shell's recorded start_time it is still our shell; otherwise the OS
///   recycled the number and we refuse the candidate (prefer leaking a known
///   orphan over killing a stranger's session).
#[cfg(unix)]
fn leader_is_sweep_candidate(registered_start: u64, holder_start: Option<u64>) -> bool {
    match holder_start {
        None => true,
        Some(start) => start == registered_start,
    }
}

/// PIDs whose Unix sessions should be swept on app exit. Tracked (in-map)
/// and registered (already-removed) leaders are run through the SAME
/// `leader_is_sweep_candidate` identity check: an in-map session's shell may
/// already have been reaped (freeing its PID for reuse) while the reader
/// task still holds the session, so a live map entry is not proof its PID is
/// still ours.
///
/// `holder_start` resolves a PID to its current holder's start_time, so the
/// predicate sees the same view the sweep loop is about to iterate. It is a
/// closure (not `&System`) so unit tests can inject a synthetic holder map.
#[cfg(unix)]
pub(super) fn collect_sweep_sids(
    tracked: impl Iterator<Item = (u32, u64)>,
    holder_start: impl Fn(u32) -> Option<u64>,
) -> std::collections::HashSet<u32> {
    let mut sids: std::collections::HashSet<u32> = std::collections::HashSet::new();
    if let Ok(reg) = pending_exit_session_leaders().lock() {
        for (&pid, &registered_start) in reg.iter() {
            if leader_is_sweep_candidate(registered_start, holder_start(pid)) {
                sids.insert(pid);
            }
        }
    }
    for (pid, registered_start) in tracked {
        if leader_is_sweep_candidate(registered_start, holder_start(pid)) {
            sids.insert(pid);
        }
    }
    sids
}

#[cfg(all(test, unix))]
mod tests {
    use super::{collect_sweep_sids, leader_is_sweep_candidate, pending_exit_session_leaders};
    use std::collections::HashMap;

    // Hold this across setup, assertions, and cleanup in every registry test.
    // The registry's own mutex protects individual operations, but another
    // parallel test can still clear the fixture between register and collect.
    static REGISTRY_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    // The session-leader registry is a process-global static shared across
    // tests; this helper drains it so each case starts from a known state.
    fn reset_registry() {
        pending_exit_session_leaders()
            .lock()
            .expect("registry poisoned")
            .clear();
    }

    #[test]
    fn sweep_candidate_when_shell_dead_and_pid_not_reused() {
        // Shell PID gone, no holder: orphaned descendants are safe to sweep.
        assert!(leader_is_sweep_candidate(1000, None));
    }

    #[test]
    fn sweep_candidate_when_pid_still_held_by_our_shell() {
        // PID exists with the same start_time: still our shell.
        assert!(leader_is_sweep_candidate(1000, Some(1000)));
    }

    #[test]
    fn not_a_sweep_candidate_when_pid_reused_by_a_different_process() {
        // PID exists but start_time differs: the OS recycled the number to an
        // unrelated process. We refuse the candidate to avoid killing the
        // wrong session.
        assert!(!leader_is_sweep_candidate(1000, Some(2000)));
    }

    // The P2 race: an in-map session whose shell was already reaped AND whose
    // PID was recycled to a different process must NOT be swept blindly. This
    // is the exact scenario the reviewer flagged — tracked_pids used to bypass
    // the start_time check. Both tracked and registered paths must reject it.
    #[test]
    fn collect_sweep_sids_rejects_reused_pid_in_both_tracked_and_registered() {
        let _registry_guard = REGISTRY_TEST_LOCK
            .lock()
            .expect("registry test lock poisoned");
        reset_registry();
        // Registered leader: shell exited, OS reused its PID for a process
        // with a different start_time.
        super::register_session_leader(100, 1000);
        // Tracked (in-map) session: shell reaped, PID recycled to a different
        // start_time while the reader still holds the session.
        let tracked = [(200u32, 2000u64)];

        // Synthetic holder map: PID 100 and 200 now exist but with different
        // start_times than the ones we registered — simulating PID reuse.
        let holders: HashMap<u32, u64> = [(100, 9999u64), (200, 8888u64)].into_iter().collect();
        let holder_start = |pid: u32| holders.get(&pid).copied();

        let sids = collect_sweep_sids(tracked.into_iter(), holder_start);

        assert!(
            !sids.contains(&100),
            "registered leader with reused PID must be excluded"
        );
        assert!(
            !sids.contains(&200),
            "tracked session with reused PID must be excluded (the P2 race)"
        );

        reset_registry();
    }

    #[test]
    fn collect_sweep_sids_keeps_shells_with_matching_or_absent_holder() {
        let _registry_guard = REGISTRY_TEST_LOCK
            .lock()
            .expect("registry test lock poisoned");
        reset_registry();
        // Registered leader whose shell is still alive (start_time matches).
        super::register_session_leader(100, 1000);
        // Tracked session whose shell died without PID reuse (holder absent).
        let tracked = [(200u32, 2000u64)];

        // PID 100 still ours (start_time 1000); PID 200 gone.
        let holders: HashMap<u32, u64> = [(100, 1000u64)].into_iter().collect();
        let holder_start = |pid: u32| holders.get(&pid).copied();

        let sids = collect_sweep_sids(tracked.into_iter(), holder_start);
        assert!(sids.contains(&100), "live shell still ours is a candidate");
        assert!(
            sids.contains(&200),
            "dead shell with no PID reuse is a candidate (orphan sweep)"
        );

        reset_registry();
    }
}
