//! Transient spawn-error detection for the CLI subprocess retry loop.

use std::io;

pub(super) const SPAWN_RETRY_ATTEMPTS: usize = 3;
pub(super) const SPAWN_RETRY_BASE_DELAY_MS: u64 = 250;

pub(super) fn is_transient_spawn_error(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    ) || transient_spawn_os_error(err)
}

#[cfg(unix)]
fn transient_spawn_os_error(err: &io::Error) -> bool {
    err.raw_os_error().is_some_and(|code| code == libc::EAGAIN)
}

#[cfg(not(unix))]
fn transient_spawn_os_error(_err: &io::Error) -> bool {
    false
}
