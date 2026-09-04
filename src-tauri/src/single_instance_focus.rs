//! macOS hand-off that lets a second app launch focus the running instance.
//!
//! `tauri-plugin-single-instance` forwards a second launch's argv to the
//! primary instance over `/tmp/<identifier>_si.sock` and exits the new
//! process. The primary's callback then shows and focuses its main window,
//! but since macOS 14 cooperative activation ignores activation requests
//! from an app the user did not just interact with, so a backgrounded
//! primary stays in the background and the launch looks like a dead click:
//! the Dock icon bounces once and no window appears. The one process that
//! does hold the user's activation intent is the freshly launched one, so
//! before the plugin forwards and exits, it resolves the socket listener's
//! PID and activates that application itself — the same hand-off Chromium's
//! process singleton performs.

use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;

use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};

/// `<sys/un.h>` option level/name for a Unix socket peer's PID; `libc` does
/// not export them for Apple targets.
const SOL_LOCAL: libc::c_int = 0;
const LOCAL_PEERPID: libc::c_int = 0x002;

/// Best-effort: bring the primary instance forward while this process still
/// owns the user's activation intent. Every failure path returns silently —
/// the single-instance plugin right after this still forwards argv and exits
/// this process, so the worst case is the pre-fix behavior (forward without
/// focus), never a broken launch.
pub(crate) fn activate_running_instance(identifier: &str) {
    // Mirror of the plugin's `socket_path` for a build without its `semver`
    // feature. If the plugin ever changes its scheme this probe misses the
    // socket and degrades to a no-op.
    let socket = format!("/tmp/{}_si.sock", identifier.replace(['.', '-'], "_"));

    let Ok(mut stream) = UnixStream::connect(&socket) else {
        // No listener: this launch becomes the primary instance.
        return;
    };

    let mut pid: libc::pid_t = 0;
    let mut pid_len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            SOL_LOCAL,
            LOCAL_PEERPID,
            std::ptr::addr_of_mut!(pid).cast(),
            &mut pid_len,
        )
    };

    // The listener treats every accepted connection as one notification once
    // it closes, so leave a well-formed empty payload (the cwd/argv separator
    // with neither side populated) rather than an unparseable stream. The
    // plugin sends the real argv over its own connection right after this.
    let _ = stream.write_all(b"\0\0");
    drop(stream);

    if rc != 0 || pid <= 0 {
        return;
    }

    let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) else {
        return;
    };
    // `ActivateIgnoringOtherApps` is a no-op on macOS 14+, where holding the
    // user's launch intent is what grants this request, but it is still
    // required for cross-application activation on older systems.
    #[allow(deprecated)]
    let options = NSApplicationActivationOptions::ActivateAllWindows
        | NSApplicationActivationOptions::ActivateIgnoringOtherApps;
    if !app.activateWithOptions(options) {
        tracing::debug!("could not activate the already-running app instance");
    }
}
