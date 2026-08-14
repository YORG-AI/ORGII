//! Workspace-memory lock — file-based mutex for `auto_dream` consolidation.
//!
//! The lock file (`.consolidate-lock`) lives inside the memory directory
//! (`{workspace}/.orgii/workspace-memory/`). Its mtime IS the
//! `lastConsolidatedAt` timestamp. The body contains the holder's PID for
//! crash recovery.
//!
//! **Note:** despite the historical name "consolidation-lock", this file
//! coordinates **`auto_dream`** (markdown consolidation of workspace-memory
//! files), NOT the L3 learnings consolidation engine in
//! `super::super::consolidation`. The two subsystems are unrelated.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tracing::warn;

const LOCK_FILE: &str = ".consolidate-lock";

/// Stale threshold: even if the PID is live, reclaim after this duration.
const HOLDER_STALE_MS: u64 = 60 * 60 * 1000; // 1 hour

/// Returns the lock file path for a workspace.
fn lock_path(workspace: &Path) -> PathBuf {
    super::memory_dir(workspace).join(LOCK_FILE)
}

/// Read the mtime of the lock file as `lastConsolidatedAt`.
/// Returns 0 if the file doesn't exist.
pub fn read_last_consolidated_at(workspace: &Path) -> u64 {
    let path = lock_path(workspace);
    match fs::metadata(&path) {
        Ok(meta) => meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        Err(_) => 0,
    }
}

/// Hours since the last consolidation.
pub fn hours_since_last_consolidation(workspace: &Path) -> f64 {
    let last_at = read_last_consolidated_at(workspace);
    if last_at == 0 {
        return f64::MAX; // Never consolidated — always eligible
    }
    let now_ms = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    (now_ms.saturating_sub(last_at)) as f64 / 3_600_000.0
}

/// RAII lease for an acquired auto-dream lock. Unless committed after a
/// successful consolidation, dropping the lease restores the prior lock
/// timestamp. This also covers outer task timeout/cancellation, where the
/// consolidation future is dropped before its explicit error arm runs.
pub struct ConsolidationLease {
    workspace: PathBuf,
    prior_mtime_ms: u64,
    committed: bool,
}

impl ConsolidationLease {
    pub fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for ConsolidationLease {
    fn drop(&mut self) {
        if !self.committed {
            rollback(&self.workspace, self.prior_mtime_ms);
        }
    }
}

/// Try to acquire the consolidation lock as an RAII lease.
pub fn try_acquire_lease(workspace: &Path) -> Result<Option<ConsolidationLease>, String> {
    try_acquire(workspace).map(|prior| {
        prior.map(|prior_mtime_ms| ConsolidationLease {
            workspace: workspace.to_path_buf(),
            prior_mtime_ms,
            committed: false,
        })
    })
}

/// Try to acquire the consolidation lock.
///
/// Returns `Ok(prior_mtime_ms)` on success, `Ok(None)` if blocked by
/// another process, `Err` on I/O failure.
///
/// The lock is "acquired" by writing our PID and verifying we won.
pub fn try_acquire(workspace: &Path) -> Result<Option<u64>, String> {
    let path = lock_path(workspace);
    let mem_dir = super::memory_dir(workspace);

    // Read existing lock state
    let (mtime_ms, holder_pid) = read_lock_state(&path);

    // Check if held by a live process
    if let Some(mtime) = mtime_ms {
        let now_ms = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        if now_ms.saturating_sub(mtime) < HOLDER_STALE_MS {
            if let Some(pid) = holder_pid {
                if is_process_running(pid) {
                    return Ok(None); // Blocked by live holder
                }
            }
        }
        // Dead PID or stale — reclaim
    }

    // Ensure memory dir exists
    fs::create_dir_all(&mem_dir).map_err(|err| format!("mkdir failed: {}", err))?;

    // Write our PID
    let our_pid = std::process::id();
    fs::write(&path, our_pid.to_string()).map_err(|err| format!("write lock: {}", err))?;

    // Verify we won (race detection)
    let verify = fs::read_to_string(&path).map_err(|err| format!("read lock: {}", err))?;
    let winner_pid: u32 = verify
        .trim()
        .parse()
        .map_err(|_| "lock body not a PID".to_string())?;

    if winner_pid != our_pid {
        return Ok(None); // Lost the race
    }

    Ok(Some(mtime_ms.unwrap_or(0)))
}

/// Rollback the lock mtime to its pre-acquire state.
///
/// Called after a failed consolidation to restore the time gate.
/// If `prior_mtime_ms` is 0, removes the lock file entirely.
pub fn rollback(workspace: &Path, prior_mtime_ms: u64) {
    let path = lock_path(workspace);

    if prior_mtime_ms == 0 {
        if let Err(err) = fs::remove_file(&path) {
            // NotFound is the expected "no lock to clean up" case (e.g.
            // another process already removed it). Anything else means
            // the lock is stuck and the next acquire will fail loudly,
            // so surface it now.
            if err.kind() != std::io::ErrorKind::NotFound {
                warn!(
                    "[consolidation_lock] rollback remove failed for '{}': {}",
                    path.display(),
                    err
                );
            }
        }
        return;
    }

    // Clear the PID body
    if let Err(err) = fs::write(&path, "") {
        warn!("[consolidation_lock] rollback write failed: {}", err);
        return;
    }

    // Restore the mtime
    if let Err(err) = set_file_mtime(&path, prior_mtime_ms) {
        warn!("[consolidation_lock] rollback mtime failed: {}", err);
    }
}

/// Record a successful consolidation by writing the lock file.
pub fn record_consolidation(workspace: &Path) -> Result<(), String> {
    let mem_dir = super::memory_dir(workspace);
    fs::create_dir_all(&mem_dir).map_err(|err| format!("mkdir: {}", err))?;

    let path = lock_path(workspace);
    let pid = std::process::id();
    fs::write(&path, pid.to_string()).map_err(|err| format!("write lock: {}", err))?;
    Ok(())
}

// ============================================
// Helpers
// ============================================

fn read_lock_state(path: &Path) -> (Option<u64>, Option<u32>) {
    // ENOENT is the legitimate "no lock yet" case and stays quiet.
    // Any other metadata failure (permission flip, partial mount)
    // is diagnostic — silent `(None, None)` would let `try_acquire`
    // race against a lock we couldn't read, potentially causing two
    // consolidation passes to overlap.
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(err) => {
            if err.kind() != std::io::ErrorKind::NotFound {
                warn!(
                    "[consolidation_lock] metadata failed at {}: {} — treating as no lock; consolidation may race",
                    path.display(),
                    err
                );
            }
            return (None, None);
        }
    };

    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);

    // A corrupt PID body (read failure, non-UTF-8, non-numeric)
    // would silently degrade the live-holder check to "no holder
    // PID known", letting `try_acquire` reclaim a lock that was
    // actually held by a live process. Warn so the corruption
    // surfaces; the reclaim semantics still apply (better to
    // unblock than to hang).
    let pid = match fs::read_to_string(path) {
        Ok(body) => match body.trim().parse::<u32>() {
            Ok(p) => Some(p),
            Err(err) => {
                warn!(
                    "[consolidation_lock] PID body parse failed at {}: {} — live-holder check will be skipped; lock may be reclaimed prematurely",
                    path.display(),
                    err
                );
                None
            }
        },
        Err(err) => {
            warn!(
                "[consolidation_lock] PID body read failed at {}: {} — live-holder check will be skipped",
                path.display(),
                err
            );
            None
        }
    };

    (mtime_ms, pid)
}

/// Cross-platform check if a PID is alive.
fn is_process_running(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // kill(pid, 0) checks existence without sending a signal
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false // Conservative: assume dead on non-Unix
    }
}

/// Set file mtime (cross-platform).
fn set_file_mtime(path: &Path, mtime_ms: u64) -> Result<(), String> {
    let secs = (mtime_ms / 1000) as i64;

    #[cfg(unix)]
    {
        use std::ffi::CString;
        let path_cstr = CString::new(path.to_string_lossy().as_bytes())
            .map_err(|e| format!("CString: {}", e))?;
        let times = [
            libc::timespec {
                tv_sec: secs,
                tv_nsec: ((mtime_ms % 1000) * 1_000_000) as _,
            },
            libc::timespec {
                tv_sec: secs,
                tv_nsec: ((mtime_ms % 1000) * 1_000_000) as _,
            },
        ];
        let ret = unsafe { libc::utimensat(libc::AT_FDCWD, path_cstr.as_ptr(), times.as_ptr(), 0) };
        if ret != 0 {
            return Err(format!(
                "utimensat failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = (path, secs);
        Err("set_file_mtime not implemented on this platform".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_read_last_consolidated_no_file() {
        let tmp = TempDir::new().unwrap();
        assert_eq!(read_last_consolidated_at(tmp.path()), 0);
    }

    #[test]
    fn test_hours_since_never_consolidated() {
        let tmp = TempDir::new().unwrap();
        let hours = hours_since_last_consolidation(tmp.path());
        assert!(hours > 1_000_000.0); // f64::MAX
    }

    #[test]
    fn test_acquire_fresh() {
        let tmp = TempDir::new().unwrap();
        let result = try_acquire(tmp.path());
        assert!(result.is_ok());
        let prior = result.unwrap();
        assert_eq!(prior, Some(0)); // No prior lock
    }

    #[test]
    fn test_acquire_blocks_when_live() {
        let tmp = TempDir::new().unwrap();

        // First acquire
        let r1 = try_acquire(tmp.path()).unwrap();
        assert!(r1.is_some());

        // Second acquire from same process is blocked because the lock is
        // fresh and our PID is live.
        let r2 = try_acquire(tmp.path()).unwrap();
        assert!(r2.is_none(), "should be blocked by live holder");
    }

    #[test]
    fn test_record_and_read() {
        let tmp = TempDir::new().unwrap();
        record_consolidation(tmp.path()).unwrap();

        let last_at = read_last_consolidated_at(tmp.path());
        assert!(last_at > 0);

        let hours = hours_since_last_consolidation(tmp.path());
        assert!(hours < 1.0); // Just recorded
    }

    #[test]
    fn test_rollback_removes_file() {
        let tmp = TempDir::new().unwrap();
        record_consolidation(tmp.path()).unwrap();

        rollback(tmp.path(), 0);

        assert_eq!(read_last_consolidated_at(tmp.path()), 0);
    }

    #[test]
    fn dropped_lease_rolls_back_fresh_lock() {
        let tmp = TempDir::new().unwrap();
        {
            let lease = try_acquire_lease(tmp.path())
                .expect("acquire lease")
                .expect("lease available");
            assert!(read_last_consolidated_at(tmp.path()) > 0);
            drop(lease);
        }
        assert_eq!(read_last_consolidated_at(tmp.path()), 0);
    }

    #[test]
    fn committed_lease_keeps_success_timestamp() {
        let tmp = TempDir::new().unwrap();
        let lease = try_acquire_lease(tmp.path())
            .expect("acquire lease")
            .expect("lease available");
        lease.commit();
        assert!(read_last_consolidated_at(tmp.path()) > 0);
    }

    #[test]
    fn test_lock_path() {
        let workspace = Path::new("/home/user/workspace");
        let expected =
            PathBuf::from("/home/user/workspace/.orgii/workspace-memory/.consolidate-lock");
        assert_eq!(lock_path(workspace), expected);
    }
}
