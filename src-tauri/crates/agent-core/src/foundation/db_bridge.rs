//! Inversion-of-control bridge to the live SQLite connection getter.
//!
//! `agent_core` needs to open ad-hoc SQLite connections for memory,
//! consolidation, reflection, and learning subsystems, but it must compile
//! without depending on `session_persistence` (or the `database` workspace
//! crate). Same pattern as [`super::bus::event_pipeline_bridge`]:
//! the wire crate fills in a `OnceLock<fn>` slot at startup, and call sites
//! inside `agent_core` go through the public wrapper here.
//!
//! Unlike the bus bridge, an unregistered call here is not safely
//! degradable — a missing connection would silently corrupt or skip
//! persistence — so the wrapper logs at `error!` and returns
//! `rusqlite::Error::InvalidPath` instead of panicking. Callers already
//! propagate `rusqlite::Result` so the error surfaces all the way to
//! the Tauri command boundary as a normal `String` error rather than
//! aborting the process.

use std::sync::OnceLock;

/// Slot signature for `database::db::get_connection` (re-exported through
/// `session_persistence::get_connection`). Returns a fully configured,
/// pooled connection to `~/.orgii/sessions.db`.
pub type GetConnectionFn = fn() -> rusqlite::Result<database::db::PooledConnection>;

static GET_CONNECTION: OnceLock<GetConnectionFn> = OnceLock::new();

/// Register the SQLite connection getter. Idempotent — subsequent calls
/// are silently ignored, which keeps tests safe across `app::run` re-entry.
/// Called once from `app::run` at startup.
pub fn register(get_connection: GetConnectionFn) {
    let _ = GET_CONNECTION.set(get_connection);
}

/// Open a connection to the sessions database via the registered slot.
///
/// Returns a `rusqlite::Error::InvalidPath` (not a panic) when the slot
/// is empty, after logging at `error!`. Every caller in `agent_core`
/// already propagates `rusqlite::Result` to the Tauri command boundary,
/// so the error surfaces to the frontend as a normal `String` rather
/// than aborting the process. Unlike the event-pipeline bridge there is
/// no safe default for "no connection" — the error path makes the
/// wiring gap visible without crashing the host.
pub fn get_connection() -> rusqlite::Result<database::db::PooledConnection> {
    match GET_CONNECTION.get() {
        Some(f) => f(),
        None => {
            tracing::error!(
                "[db-bridge] get_connection called before register; \
                 session_persistence::agent_core_bridge::register() \
                 must run during app::run startup"
            );
            Err(rusqlite::Error::InvalidPath(std::path::PathBuf::from(
                "<db-bridge unregistered>",
            )))
        }
    }
}
