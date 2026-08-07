//! macOS main-run-loop wake helper.
//!
//! Tauri delivers `app.emit` payloads and IPC `Channel` messages to the
//! webview by scheduling work onto the host process's main thread. On
//! macOS the main NSRunLoop sits in `Wait` between user-input events and
//! does not reliably wake for work queued from background threads (tao
//! event-loop wakeup coalescing). With the mouse idle, queued backend →
//! frontend notifications pile up undelivered and the chat UI appears
//! frozen — moving the mouse produces an input event, the run loop wakes,
//! and the backlog floods in ("it only progresses when I move the mouse").
//!
//! `CFRunLoopWakeUp` is thread-safe and O(1); nudging it right after
//! posting a notification forces the main thread to drain the queue
//! immediately. No-op on other platforms.

#[cfg(target_os = "macos")]
pub fn wake_main_runloop() {
    use core_foundation::base::TCFType;
    use core_foundation::runloop::CFRunLoop;
    // No safe wrapper for CFRunLoopWakeUp in core-foundation 0.10 — call
    // the sys binding on the retained main-run-loop handle. Thread-safe
    // per Apple docs ("CFRunLoop is thread safe": wake-up may be called
    // from any thread).
    let main = CFRunLoop::get_main();
    unsafe {
        core_foundation::runloop::CFRunLoopWakeUp(main.as_concrete_TypeRef());
    }
}

#[cfg(not(target_os = "macos"))]
pub fn wake_main_runloop() {}
