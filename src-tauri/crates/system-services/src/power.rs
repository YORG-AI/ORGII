//! System power management — "prevent system sleep" while agent sessions run.
//!
//! Exposes two Tauri commands:
//! - `system_power_acquire_sleep_inhibitor` — keep system awake (idempotent)
//! - `system_power_release_sleep_inhibitor` — allow normal sleep (idempotent)
//!
//! The frontend calls acquire/release in response to:
//! (a) the `general.preventSleepWhileRunning` setting toggling, and
//! (b) the count of actively-working sessions transitioning between 0 and >0.
//!
//! Platform implementations:
//! - macOS:   `IOPMAssertionCreateWithName` (`kIOPMAssertPreventUserIdleSystemSleep`).
//!   Releasing the assertion ID is what lets the system sleep again.
//! - Windows: `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`.
//!   Release clears with `ES_CONTINUOUS` alone.
//! - Linux:   No-op for now (D-Bus `org.freedesktop.ScreenSaver.Inhibit` can
//!   be added later if there's user demand).

use std::sync::Mutex;
use tauri::State;

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

/// Pure idempotency decision for the acquire/release state machine.
///
/// Extracted from the Tauri commands so the duplicate-call semantics can be
/// unit-tested without spinning up the Tauri runtime or invoking real FFI.
/// The commands consult these helpers to decide whether to skip the FFI
/// call entirely (when already in the desired state).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transition {
    /// Perform the underlying platform call and record the new state.
    Apply,
    /// Already in the desired state — skip the platform call.
    Skip,
}

#[doc(hidden)]
pub fn decide_acquire(currently_held: bool) -> Transition {
    if currently_held {
        Transition::Skip
    } else {
        Transition::Apply
    }
}

#[doc(hidden)]
pub fn decide_release(currently_held: bool) -> Transition {
    if currently_held {
        Transition::Apply
    } else {
        Transition::Skip
    }
}

/// Tauri-managed state. The mutex is `std::sync::Mutex` because the inner work
/// (FFI calls) is non-blocking and synchronous.
#[derive(Default)]
pub struct PowerState {
    inner: Mutex<Option<InhibitorHandle>>,
}

impl PowerState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

/// Acquire a sleep inhibitor. Idempotent — calling twice without an intervening
/// release is a no-op and returns `Ok(())`.
#[tauri::command]
pub fn system_power_acquire_sleep_inhibitor(state: State<'_, PowerState>) -> Result<(), String> {
    let mut guard = state
        .inner
        .lock()
        .map_err(|err| format!("PowerState mutex poisoned: {}", err))?;

    if decide_acquire(guard.is_some()) == Transition::Skip {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let assertion_id = macos_impl::acquire()?;
        *guard = Some(InhibitorHandle::Mac { assertion_id });
        tracing::info!(
            assertion_id,
            "[Power] Acquired macOS PreventUserIdleSystemSleep assertion"
        );
    }

    #[cfg(windows)]
    {
        windows_impl::acquire()?;
        *guard = Some(InhibitorHandle::Windows);
        tracing::info!("[Power] Acquired Windows ES_SYSTEM_REQUIRED state");
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    {
        // Linux: no implementation yet. Record the intent so release is symmetric,
        // but emit a warning so users on Linux know the toggle is a no-op.
        *guard = Some(InhibitorHandle::Unsupported);
        tracing::warn!(
            "[Power] Sleep inhibition not implemented on this platform; toggle is a no-op"
        );
    }

    Ok(())
}

/// Release the sleep inhibitor. Idempotent — calling without a prior acquire is
/// a no-op and returns `Ok(())`.
#[tauri::command]
pub fn system_power_release_sleep_inhibitor(state: State<'_, PowerState>) -> Result<(), String> {
    let mut guard = state
        .inner
        .lock()
        .map_err(|err| format!("PowerState mutex poisoned: {}", err))?;

    if decide_release(guard.is_some()) == Transition::Skip {
        return Ok(());
    }

    let Some(handle) = guard.take() else {
        // Defensive: decide_release returned Apply, so this branch is
        // unreachable, but we keep the early return so the match below
        // doesn't need to handle an Option.
        return Ok(());
    };

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
