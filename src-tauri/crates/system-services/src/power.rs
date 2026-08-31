//! System power management — "prevent system sleep" while agent sessions run.
//!
//! Exposes two Tauri commands:
//! - `system_power_acquire_sleep_inhibitor` — keep system awake (per-window, refcounted)
//! - `system_power_release_sleep_inhibitor` — allow normal sleep (per-window, refcounted)
//!
//! The frontend calls acquire/release in response to:
//! (a) the `general.preventSleepWhileRunning` setting toggling, and
//! (b) the count of actively-working sessions transitioning between 0 and >0.
//!
//! Multi-window semantics: every OS window (the main window plus detached
//! `app-window-session-<id>` windows) runs its own copy of the frontend hook
//! and calls these commands independently, but the OS assertion is
//! process-wide. The state is therefore a holder SET keyed by window label
//! backing a single platform handle: a window's acquire registers its label
//! and the platform assertion is created only for the first holder; a
//! window's release removes only its own label and the assertion is dropped
//! only when the last holder leaves. This prevents one window's release
//! (e.g. a detached session window closing or its session going idle first)
//! from tearing the assertion out from under another window that still
//! needs it.
//!
//! Leak protection: a window can be destroyed without its JS cleanup ever
//! running. The `WindowEvent::Destroyed` handler in `lib.rs` calls
//! [`release_sleep_inhibitor_for_window_label`] so a dead window's holder
//! entry cannot pin the assertion until process exit.
//!
//! Platform implementations:
//! - macOS:   `IOPMAssertionCreateWithName` (`kIOPMAssertPreventUserIdleSystemSleep`).
//!   Releasing the assertion ID is what lets the system sleep again.
//! - Windows: `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`.
//!   Release clears with `ES_CONTINUOUS` alone.
//! - Linux:   No-op for now (D-Bus `org.freedesktop.ScreenSaver.Inhibit` can
//!   be added later if there's user demand).

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

#[cfg(target_os = "macos")]
mod macos_impl {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    type IOPMAssertionID = u32;
    type IOReturn = i32;
    const K_IO_RETURN_SUCCESS: IOReturn = 0;
    const K_IOPM_ASSERTION_LEVEL_ON: u32 = 255;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: CFStringRef,
            assertion_level: u32,
            assertion_name: CFStringRef,
            assertion_id: *mut IOPMAssertionID,
        ) -> IOReturn;

        fn IOPMAssertionRelease(assertion_id: IOPMAssertionID) -> IOReturn;
    }

    pub fn acquire() -> Result<u32, String> {
        // kIOPMAssertPreventUserIdleSystemSleep — prevents the system from
        // sleeping due to idleness. Display may still dim/sleep.
        let assertion_type = CFString::new("PreventUserIdleSystemSleep");
        let assertion_name = CFString::new("ORGII — agent session running");
        let mut id: IOPMAssertionID = 0;
        let result = unsafe {
            IOPMAssertionCreateWithName(
                assertion_type.as_concrete_TypeRef(),
                K_IOPM_ASSERTION_LEVEL_ON,
                assertion_name.as_concrete_TypeRef(),
                &mut id,
            )
        };
        if result == K_IO_RETURN_SUCCESS {
            Ok(id)
        } else {
            Err(format!("IOPMAssertionCreateWithName failed: {}", result))
        }
    }

    pub fn release(id: u32) -> Result<(), String> {
        let result = unsafe { IOPMAssertionRelease(id) };
        if result == K_IO_RETURN_SUCCESS {
            Ok(())
        } else {
            Err(format!("IOPMAssertionRelease failed: {}", result))
        }
    }
}

#[cfg(windows)]
mod windows_impl {
    use windows::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
    };

    pub fn acquire() -> Result<(), String> {
        let prev = unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
        if prev.0 == 0 {
            Err("SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) returned 0".into())
        } else {
            Ok(())
        }
    }

    pub fn release() -> Result<(), String> {
        let prev = unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        if prev.0 == 0 {
            Err("SetThreadExecutionState(ES_CONTINUOUS) returned 0".into())
        } else {
            Ok(())
        }
    }
}

/// Platform-specific handle for an active inhibition.
///
/// macOS stores the IOPMAssertion ID so we can release the exact assertion we
/// created. Windows / Linux only need a "we hold one" flag because their APIs
/// are process-wide rather than handle-based.
#[derive(Debug, Clone, Copy)]
enum InhibitorHandle {
    #[cfg(target_os = "macos")]
    Mac { assertion_id: u32 },
    #[cfg(windows)]
    Windows,
    #[cfg(not(any(target_os = "macos", windows)))]
    Unsupported,
}

/// Refcounted inhibitor state: the set of window labels that currently want
/// the system kept awake, plus the single process-wide platform handle that
/// backs them.
///
/// Invariant (re-established by every mutation): the platform handle exists
/// iff at least one holder is registered — it is created for the first
/// holder and dropped exactly when the last holder is removed.
#[derive(Debug, Default)]
struct PowerInner {
    handle: Option<InhibitorHandle>,
    holders: HashSet<String>,
}

/// Process-wide inhibitor state.
///
/// A static rather than Tauri-managed state because (a) the OS assertion
/// itself is process-wide, not per-window, and (b) the
/// `WindowEvent::Destroyed` cleanup path
/// ([`release_sleep_inhibitor_for_window_label`]) runs inside a window-event
/// closure where no `State` extractor is available.
static POWER_INNER: OnceLock<Mutex<PowerInner>> = OnceLock::new();

fn power_inner() -> &'static Mutex<PowerInner> {
    POWER_INNER.get_or_init(|| Mutex::new(PowerInner::default()))
}

fn lock_power_inner() -> Result<std::sync::MutexGuard<'static, PowerInner>, String> {
    power_inner()
        .lock()
        .map_err(|err| format!("Power inhibitor mutex poisoned: {}", err))
}

/// Pure refcount decision for the acquire/release state machine.
///
/// Extracted from the Tauri commands so the per-window holder semantics can
/// be unit-tested without spinning up the Tauri runtime or invoking real FFI.
/// The commands consult these helpers to decide whether to perform the
/// process-wide platform call or skip it (already in the desired state, or
/// other windows still hold the inhibitor).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transition {
    /// Perform the underlying platform call and record the new state.
    Apply,
    /// Already in the desired state — skip the platform call.
    Skip,
}

/// Register `label` as a holder and decide whether the process-wide OS
/// assertion must be created (`currently_held` is whether a platform handle
/// already exists). Inserting an already-registered label is idempotent.
#[doc(hidden)]
pub fn decide_acquire(
    holders: &mut HashSet<String>,
    currently_held: bool,
    label: &str,
) -> Transition {
    holders.insert(label.to_owned());
    if currently_held {
        Transition::Skip
    } else {
        Transition::Apply
    }
}

/// Drop `label` from the holders and decide whether the process-wide OS
/// assertion must be released — only when the last holder leaves. Releasing
/// a label that never acquired is a no-op and never disturbs other holders.
#[doc(hidden)]
pub fn decide_release(
    holders: &mut HashSet<String>,
    currently_held: bool,
    label: &str,
) -> Transition {
    holders.remove(label);
    if currently_held && holders.is_empty() {
        Transition::Apply
    } else {
        Transition::Skip
    }
}

/// Tauri-managed marker retained so the `app.manage(PowerState::new())` call
/// in `lib.rs` setup stays valid. The actual inhibitor state lives in the
/// process-wide `POWER_INNER` static (see its doc for why).
#[derive(Default)]
pub struct PowerState;

impl PowerState {
    pub fn new() -> Self {
        Self
    }
}

/// Perform the platform-specific "keep awake" call and return the handle to
/// store. Called only when no handle exists yet (first holder).
fn platform_acquire() -> Result<InhibitorHandle, String> {
    #[cfg(target_os = "macos")]
    {
        let assertion_id = macos_impl::acquire()?;
        tracing::info!(
            assertion_id,
            "[Power] Acquired macOS PreventUserIdleSystemSleep assertion"
        );
        Ok(InhibitorHandle::Mac { assertion_id })
    }

    #[cfg(windows)]
    {
        windows_impl::acquire()?;
        tracing::info!("[Power] Acquired Windows ES_SYSTEM_REQUIRED state");
        Ok(InhibitorHandle::Windows)
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    {
        // Linux: no implementation yet. Record the intent so release is
        // symmetric, but emit a warning so users on Linux know the toggle is
        // a no-op.
        tracing::warn!(
            "[Power] Sleep inhibition not implemented on this platform; toggle is a no-op"
        );
        Ok(InhibitorHandle::Unsupported)
    }
}

/// Perform the platform-specific release for a previously acquired handle.
/// Called only when the last holder leaves.
fn platform_release(handle: InhibitorHandle) -> Result<(), String> {
    match handle {
        #[cfg(target_os = "macos")]
        InhibitorHandle::Mac { assertion_id } => {
            macos_impl::release(assertion_id)?;
            tracing::info!(
                assertion_id,
                "[Power] Released macOS PreventUserIdleSystemSleep assertion"
            );
        }
        #[cfg(windows)]
        InhibitorHandle::Windows => {
            windows_impl::release()?;
            tracing::info!("[Power] Released Windows ES_SYSTEM_REQUIRED state");
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        InhibitorHandle::Unsupported => {
            tracing::debug!("[Power] Released no-op inhibitor on unsupported platform");
        }
    }
    Ok(())
}

fn acquire_for_label(label: &str) -> Result<(), String> {
    let mut guard = lock_power_inner()?;

    let currently_held = guard.handle.is_some();
    if decide_acquire(&mut guard.holders, currently_held, label) == Transition::Skip {
        tracing::debug!(
            label,
            holders = guard.holders.len(),
            "[Power] Sleep inhibitor already held; holder registered"
        );
        return Ok(());
    }

    match platform_acquire() {
        Ok(handle) => {
            guard.handle = Some(handle);
            Ok(())
        }
        Err(err) => {
            // Roll back the holder registration: a failed platform call must
            // not leave a phantom holder that would keep a future assertion
            // alive after every real holder has released.
            guard.holders.remove(label);
            Err(err)
        }
    }
}

fn release_for_label(label: &str) -> Result<(), String> {
    let mut guard = lock_power_inner()?;

    let currently_held = guard.handle.is_some();
    if decide_release(&mut guard.holders, currently_held, label) == Transition::Skip {
        tracing::debug!(
            label,
            holders = guard.holders.len(),
            "[Power] Sleep inhibitor release skipped (other holders remain or nothing held)"
        );
        return Ok(());
    }

    let Some(handle) = guard.handle.take() else {
        // Defensive: decide_release returns Apply only when a handle exists,
        // so this branch is unreachable, but we keep the early return so the
        // release below doesn't need to handle an Option.
        return Ok(());
    };

    platform_release(handle)
}

/// Acquire a sleep inhibitor on behalf of the calling window. Idempotent per
/// window — calling twice without an intervening release is a no-op and
/// returns `Ok(())`. The platform assertion is created only for the first
/// holding window; later windows share it.
///
/// `window` is injected by Tauri from the invoke context — the frontend
/// payload is unchanged.
#[tauri::command]
pub fn system_power_acquire_sleep_inhibitor(window: tauri::Window) -> Result<(), String> {
    acquire_for_label(window.label())
}

/// Release the calling window's hold on the sleep inhibitor. Idempotent —
/// calling without a prior acquire is a no-op and returns `Ok(())`. The
/// platform assertion is dropped only when the last holding window releases;
/// other windows' holds are never disturbed.
#[tauri::command]
pub fn system_power_release_sleep_inhibitor(window: tauri::Window) -> Result<(), String> {
    release_for_label(window.label())
}

/// Drop `label`'s hold on the sleep inhibitor, releasing the process-wide
/// assertion if it was the last holder.
///
/// Called from the `WindowEvent::Destroyed` handler in `lib.rs`: a window can
/// be destroyed without its JS cleanup ever running (crash, direct
/// programmatic close, webview teardown racing the unmount effect), which
/// would otherwise strand its holder entry and pin the assertion until
/// process exit. Errors are logged rather than returned — nothing can
/// meaningfully handle them during window teardown.
pub fn release_sleep_inhibitor_for_window_label(label: &str) {
    if let Err(err) = release_for_label(label) {
        tracing::warn!(
            label,
            error = %err,
            "[Power] Failed to release sleep inhibitor for destroyed window"
        );
    }
}
