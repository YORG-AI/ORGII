//! Lifecycle control for the opt-in DHAT heap profiler.
//!
//! Tauri's `Application::run()` exits the process directly instead of
//! returning to `main`, so a profiler guard owned by `main` is never dropped.
//! Keep the guard here and finish it from the final `RunEvent::Exit` instead.

use std::alloc::{GlobalAlloc, Layout, System};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

const DEFAULT_START_DELAY_SECS: u64 = 15;
const MAX_START_DELAY_SECS: u64 = 60 * 60;

enum ProfilerState {
    NotScheduled,
    Scheduled,
    Running(dhat::Profiler),
    Finished,
}

static PROFILER_STATE: OnceLock<Mutex<ProfilerState>> = OnceLock::new();
static PROFILING_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Global allocator that bypasses DHAT until the delayed profiling window.
///
/// Allocations made before profiling can safely be freed while profiling is
/// active: DHAT explicitly ignores deallocations for blocks it did not record.
/// The inverse is also safe because DHAT ultimately delegates storage to the
/// system allocator.
pub struct DhatAllocator;

impl DhatAllocator {
    pub const fn new() -> Self {
        Self
    }

    fn is_active() -> bool {
        PROFILING_ACTIVE.load(Ordering::Acquire)
    }
}

// SAFETY: both delegated allocators use the platform system allocator for the
// actual storage. Switching changes only whether DHAT records the operation;
// it does not change allocation layout or which allocator owns the pointer.
unsafe impl GlobalAlloc for DhatAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if Self::is_active() {
            unsafe { GlobalAlloc::alloc(&dhat::Alloc, layout) }
        } else {
            unsafe { GlobalAlloc::alloc(&System, layout) }
        }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        if Self::is_active() {
            unsafe { GlobalAlloc::dealloc(&dhat::Alloc, ptr, layout) }
        } else {
            unsafe { GlobalAlloc::dealloc(&System, ptr, layout) }
        }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if Self::is_active() {
            unsafe { GlobalAlloc::realloc(&dhat::Alloc, ptr, layout, new_size) }
        } else {
            unsafe { GlobalAlloc::realloc(&System, ptr, layout, new_size) }
        }
    }
}

fn profiler_state() -> &'static Mutex<ProfilerState> {
    PROFILER_STATE.get_or_init(|| Mutex::new(ProfilerState::NotScheduled))
}

fn lock_profiler_state() -> MutexGuard<'static, ProfilerState> {
    profiler_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn parse_start_delay_secs(value: Option<&str>) -> u64 {
    value
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|seconds| *seconds <= MAX_START_DELAY_SECS)
        .unwrap_or(DEFAULT_START_DELAY_SECS)
}

fn configured_start_delay() -> Duration {
    let raw = std::env::var("ORGII_DHAT_START_DELAY_SECS").ok();
    let seconds = parse_start_delay_secs(raw.as_deref());
    if let Some(raw) = raw.filter(|raw| raw.parse::<u64>().ok() != Some(seconds)) {
        eprintln!("[dhat] ignoring invalid ORGII_DHAT_START_DELAY_SECS={raw:?}; using {seconds}s");
    }
    Duration::from_secs(seconds)
}

fn output_path() -> PathBuf {
    std::env::var_os("ORGII_DHAT_OUTPUT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("dhat-heap.json"))
}

fn start_profiler() -> Result<dhat::Profiler, String> {
    let output_path = output_path();
    if let Some(parent) = output_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create DHAT output directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let profiler = dhat::Profiler::builder()
        .file_name(output_path.clone())
        .build();
    PROFILING_ACTIVE.store(true, Ordering::Release);
    eprintln!(
        "[dhat] Rust heap profiling started; output will be written to {} on exit",
        output_path.display()
    );
    Ok(profiler)
}

/// Schedule one profiler start after Tauri's backend setup has completed.
///
/// The one-shot delay lets the WebView and normal startup restoration settle
/// before DHAT begins capturing allocation backtraces. Repeated calls are
/// ignored, and the worker exits immediately after attempting the start.
pub(crate) fn schedule_from_env() {
    {
        let mut state = lock_profiler_state();
        if !matches!(*state, ProfilerState::NotScheduled) {
            return;
        }
        *state = ProfilerState::Scheduled;
    }

    let delay = configured_start_delay();
    eprintln!(
        "[dhat] Rust heap profiling will start in {}s; wait for the 'profiling started' message before testing",
        delay.as_secs()
    );

    if let Err(error) = std::thread::Builder::new()
        .name("orgii-dhat-start".to_string())
        .spawn(move || {
            if !delay.is_zero() {
                std::thread::sleep(delay);
            }

            let mut state = lock_profiler_state();
            if !matches!(*state, ProfilerState::Scheduled) {
                return;
            }

            match start_profiler() {
                Ok(profiler) => *state = ProfilerState::Running(profiler),
                Err(error) => {
                    *state = ProfilerState::Finished;
                    eprintln!("[dhat] failed to start Rust heap profiling: {error}");
                }
            }
        })
    {
        *lock_profiler_state() = ProfilerState::Finished;
        eprintln!("[dhat] failed to spawn delayed profiler worker: {error}");
    }
}

/// Stop profiling and synchronously write the JSON profile exactly once.
///
/// This must run from Tauri's final `RunEvent::Exit`, before Tauri terminates
/// the process with `std::process::exit` and skips ordinary Rust destructors.
pub(crate) fn finish() {
    let previous = {
        let mut state = lock_profiler_state();
        std::mem::replace(&mut *state, ProfilerState::Finished)
    };

    match previous {
        ProfilerState::Running(profiler) => {
            PROFILING_ACTIVE.store(false, Ordering::Release);
            eprintln!("[dhat] finalizing Rust heap profile...");
            drop(profiler);
            eprintln!("[dhat] Rust heap profile finalized");
        }
        ProfilerState::Scheduled => {
            eprintln!("[dhat] app exited before delayed heap profiling started");
        }
        ProfilerState::NotScheduled | ProfilerState::Finished => {}
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_start_delay_secs, DEFAULT_START_DELAY_SECS, MAX_START_DELAY_SECS};

    #[test]
    fn start_delay_accepts_bounded_seconds() {
        assert_eq!(parse_start_delay_secs(Some("0")), 0);
        assert_eq!(parse_start_delay_secs(Some("45")), 45);
        assert_eq!(
            parse_start_delay_secs(Some(&MAX_START_DELAY_SECS.to_string())),
            MAX_START_DELAY_SECS
        );
    }

    #[test]
    fn start_delay_rejects_invalid_or_unbounded_values() {
        assert_eq!(parse_start_delay_secs(None), DEFAULT_START_DELAY_SECS);
        assert_eq!(
            parse_start_delay_secs(Some("not-a-number")),
            DEFAULT_START_DELAY_SECS
        );
        assert_eq!(
            parse_start_delay_secs(Some(&(MAX_START_DELAY_SECS + 1).to_string())),
            DEFAULT_START_DELAY_SECS
        );
    }
}
