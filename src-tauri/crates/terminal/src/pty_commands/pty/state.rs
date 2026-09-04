//! Tauri-managed registry of live PTY sessions, plus the app-exit sweep that
//! kills every tracked shell together with its Unix process session.

use std::{collections::HashMap, sync::Arc};
use tauri::async_runtime::Mutex as AsyncMutex;

#[cfg(unix)]
use super::exit_sweep::{collect_sweep_sids, pending_exit_session_leaders};
use super::session::PtySession;

/// Global state container for all PTY sessions.
///
/// Managed by Tauri and accessed via `State<PtyState>` in command handlers.
/// Sessions are stored in a HashMap keyed by session ID.
pub struct PtyState {
    /// Map of session_id -> PtySession
    pub(super) sessions: Arc<AsyncMutex<HashMap<String, PtySession>>>,
}

impl PtyState {
    /// Create a new empty PTY state container.
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(AsyncMutex::new(HashMap::new())),
        }
    }

    /// Get a shared reference to the sessions map.
    ///
    /// Used to share the sessions between `PtyState` (Tauri managed state)
    /// and the OS agent's `ExecTool` (which needs direct access for PTY operations).
    pub fn sessions_arc(&self) -> Arc<AsyncMutex<HashMap<String, PtySession>>> {
        self.sessions.clone()
    }

    /// Kill every tracked PTY shell together with its entire Unix process
    /// session, then drop all sessions.
    ///
    /// App-exit only. Closing a single tab kills just the shell — a user may
    /// deliberately leave `nohup`-style descendants running. Once the app
    /// exits, though, nothing can manage those descendants: the kernel's
    /// SIGHUP on PTY close is only a polite notice, so HUP-immune processes
    /// would leak until logout.
    ///
    /// Also sweeps descendants of shells that already left the sessions map
    /// (tab closed, or shell exited naturally after launching a backgrounded
    /// job): their PIDs were registered at spawn and retained precisely so
    /// this exit sweep can still find the session. See
    /// [`pending_exit_session_leaders`].
    ///
    /// Must be called from a non-runtime thread (it blocks on the session
    /// map lock); the Tauri run-loop exit handler qualifies.
    ///
    /// Thread-safety: `self.sessions.blocking_lock()` calls
    /// `tokio::future::block_on`, which panics if the current thread is a
    /// tokio runtime worker. This is safe only because the sole caller is the
    /// `RunEvent::ExitRequested` callback, which Tauri runs synchronously on
    /// the main (wry/tao event-loop) thread — NOT a tokio async_runtime
    /// worker (those live in a separate thread pool). Do NOT call this from
    /// an `async fn`, a `spawn`/`spawn_blocking` task, or any context where
    /// a tokio runtime guard is entered; move it to a fresh `std::thread`
    /// before blocking on the lock.
    pub fn shutdown_kill_all(&self) {
        let drained: Vec<PtySession> = {
            let mut map = self.sessions.blocking_lock();
            map.drain().map(|(_, session)| session).collect()
        };

        // The shell was spawned via setsid(), so its PID is the session ID
        // of every descendant that has not detached into a session of its
        // own (a daemon's deliberate double-fork escape is respected). Sweep
        // by session, not by process group: an interactive shell's job
        // control puts each job in its own group, so killpg on the shell's
        // group would miss `bash -c ...`-style jobs entirely.
        //
        // Residual risk: the start_time guard on registered leaders closes
        // the most direct PID-reuse mis-kill path (a live process now holds
        // a recycled shell PID). It is NOT a complete proof. If the OS
        // recycled a dead shell's PID to a process Q that called setsid()
        // and forked descendants, and Q itself died before app exit, Q's
        // descendants still report `SID = <recycled PID>` while the PID is
        // currently free — indistinguishable from our dead shell. In that
        // daemon / session-launcher pattern we may mis-kill Q's orphans.
        // The policy is deliberate: when we cannot tell our orphans apart
        // from a stranger's, prefer leaking a known orphan over killing an
        // unrelated process's session.
        #[cfg(unix)]
        {
            use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

            let mut sys = System::new();
            sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing(),
            );

            // Union live sessions with the registry of shells already removed
            // (closed tab / natural exit). BOTH paths run through the same
            // start_time identity check: an in-map session may already have
            // been reaped and its PID recycled, so neither is trusted blindly.
            let sids = collect_sweep_sids(
                drained
                    .iter()
                    .filter_map(|s| s.pid.map(|p| (p, s.start_time))),
                |pid| {
                    sys.process(sysinfo::Pid::from_u32(pid))
                        .map(|p| p.start_time())
                },
            );
            if !sids.is_empty() {
                let own_pid = std::process::id();
                for (pid, process) in sys.processes() {
                    let pid = pid.as_u32();
                    // Shells still in `drained` die via Drop below, which also
                    // reaps them; skip their own PIDs to avoid a redundant
                    // signal to a process we are about to own the exit of.
                    if pid == own_pid || sids.contains(&pid) {
                        continue;
                    }
                    if process
                        .session_id()
                        .is_some_and(|sid| sids.contains(&sid.as_u32()))
                    {
                        // SIGKILL directly: anything still here already
                        // ignored the kernel's SIGHUP, and a per-process
                        // grace period would block app exit.
                        unsafe {
                            libc::kill(pid as i32, libc::SIGKILL);
                        }
                    }
                }
            }
            // Registry consumed by this exit sweep.
            if let Ok(mut reg) = pending_exit_session_leaders().lock() {
                reg.clear();
            }
        }

        // Drop kills each shell synchronously (required at app exit, where
        // detached threads are never joined). Windows tree cleanup beyond
        // the shell/conhost pair would need Job Objects; not covered here.
        drop(drained);
    }
}

impl Default for PtyState {
    fn default() -> Self {
        Self::new()
    }
}
