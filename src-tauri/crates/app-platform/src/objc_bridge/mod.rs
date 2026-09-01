//! Rust-side wrapper around `objc_catch.m` — an Objective-C `@try/@catch`
//! trampoline so ObjC exceptions from AppKit / Foundation / CoreGraphics
//! can be turned into Rust `Err` values instead of aborting the process.
//!
//! Without this, any background-thread call into (e.g.) `NSWorkspace`,
//! `NSRunningApplication`, or `CGDisplayCreateImage` on macOS 26.3 that
//! raises an NSException will trigger the Rust runtime's "cannot catch
//! foreign exceptions" abort path and kill the whole app.
//!
//! Usage:
//!
//! ```ignore
//! let apps = with_objc_catch("list_running_apps", || unsafe {
//!     msg_send![class!(NSWorkspace), sharedWorkspace]
//! })?;
//! ```
//!
//! The parent module declares `#[cfg(target_os = "macos")] pub mod objc_bridge;`,
//! so this file is only compiled on macOS — no inner gating is needed.

use std::ffi::{c_void, CStr};
use std::panic::{catch_unwind, AssertUnwindSafe};

type WorkFn = extern "C" fn(*mut c_void);

extern "C" {
    fn orgii_objc_catch(work: WorkFn, ctx: *mut c_void) -> *const std::os::raw::c_char;
    fn orgii_objc_free(s: *const std::os::raw::c_char);
}

/// Heap box carrying the Rust closure + its result slot across the C trampoline.
struct Trampoline<T, F: FnOnce() -> T> {
    f: Option<F>,
    result: Option<std::thread::Result<T>>,
}

extern "C" fn trampoline_thunk<T, F: FnOnce() -> T>(ctx: *mut c_void) {
    // SAFETY: ctx is the heap box we allocated in with_objc_catch.
    let tramp = unsafe { &mut *(ctx as *mut Trampoline<T, F>) };
    let f = tramp.f.take().expect("closure already consumed");
    // catch_unwind guards against Rust-level panics in the closure —
    // the ObjC @try/@catch above us already handles foreign exceptions.
    tramp.result = Some(catch_unwind(AssertUnwindSafe(f)));
}

/// Run `f` on the current thread, catching any ObjC exception it raises.
/// Returns `Err(exception_description)` if an NSException propagated, or
/// `Err("panic: …")` if the closure panicked.
pub fn with_objc_catch<T, F: FnOnce() -> T>(label: &str, f: F) -> Result<T, String> {
    let mut tramp: Trampoline<T, F> = Trampoline {
        f: Some(f),
        result: None,
    };
    let ctx = &mut tramp as *mut _ as *mut c_void;

    let err_ptr = unsafe { orgii_objc_catch(trampoline_thunk::<T, F>, ctx) };

    if !err_ptr.is_null() {
        let msg = unsafe { CStr::from_ptr(err_ptr) }
            .to_string_lossy()
            .into_owned();
        unsafe { orgii_objc_free(err_ptr) };
        return Err(format!("{}: ObjC exception: {}", label, msg));
    }

    match tramp.result {
        Some(Ok(v)) => Ok(v),
        Some(Err(_)) => Err(format!("{}: Rust panic during ObjC call", label)),
        None => Err(format!("{}: trampoline did not run", label)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn returns_the_closure_value_when_nothing_throws() {
        assert_eq!(with_objc_catch("add", || 1 + 1), Ok(2));
    }

    #[test]
    fn carries_non_copy_values_back_across_the_c_trampoline() {
        // The result travels through a heap box behind a `*mut c_void`, so a
        // type that owns an allocation is the interesting case.
        let value = with_objc_catch("build", || vec!["a".to_string(), "b".to_string()])
            .expect("no exception");

        assert_eq!(value, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn runs_the_closure_exactly_once() {
        static CALLS: AtomicUsize = AtomicUsize::new(0);

        with_objc_catch("count", || {
            CALLS.fetch_add(1, Ordering::SeqCst);
        })
        .expect("no exception");

        assert_eq!(CALLS.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn converts_a_rust_panic_into_an_err_instead_of_unwinding_into_objc() {
        // Unwinding across the `extern "C"` trampoline would abort the
        // process, which is exactly what this bridge exists to prevent.
        let result: Result<(), String> =
            with_objc_catch("explode", || panic!("boom inside the trampoline"));

        let err = result.unwrap_err();
        assert_eq!(err, "explode: Rust panic during ObjC call");
        // The label is the only breadcrumb in the log, so it has to survive.
        assert!(err.starts_with("explode:"));
    }

    #[test]
    fn a_panic_in_one_call_does_not_poison_the_next() {
        let _: Result<(), String> = with_objc_catch("first", || panic!("boom"));

        assert_eq!(with_objc_catch("second", || "still works"), Ok("still works"));
    }

    #[test]
    fn moves_captured_state_into_the_closure() {
        let owned = String::from("captured");

        let result = with_objc_catch("move", move || owned.len()).expect("no exception");

        assert_eq!(result, 8);
    }
}
