//! Process-global Agent Org runtime availability state.
//!
//! When the namespace coordinator ([`super::schema`]) fails, whole-DB
//! sessions.db init must not fail with it — a corrupted Agent Org runtime
//! namespace must never take ordinary chat down. The startup hook records
//! the failure here via [`super::init_agent_org_schemas_scoped`], sessions.db
//! init proceeds, and every Agent Org store entry that would touch the
//! runtime namespace acquires its connection through [`runtime_connection`],
//! which returns a structured "agent-org runtime unavailable" error instead
//! of a raw missing-table SQL failure.
//!
//! Under `cfg(test)` the state is thread-local so parallel tests cannot
//! poison each other through the process-global; production uses a
//! process-wide static because the init hook and the command surfaces run
//! on different threads.

use rusqlite::{ffi, Connection, Error as SqliteError, Result as SqliteResult};

/// Stable prefix of every gated error so command surfaces and the frontend
/// can recognize the scoped-degradation condition.
pub const AGENT_ORG_RUNTIME_UNAVAILABLE_PREFIX: &str = "agent-org runtime unavailable: ";

#[cfg(not(test))]
static STATE: std::sync::RwLock<Option<String>> = std::sync::RwLock::new(None);

#[cfg(test)]
thread_local! {
    static STATE: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// Record that the Agent Org runtime namespace could not be initialized.
///
/// Every subsequent [`runtime_connection`] fails with the structured
/// unavailable error until [`mark_agent_org_runtime_available`] clears it
/// (a later successful coordinator run, e.g. a rotated test sandbox).
pub fn mark_agent_org_runtime_unavailable(reason: impl Into<String>) {
    let reason = reason.into();
    #[cfg(not(test))]
    {
        *STATE.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(reason);
    }
    #[cfg(test)]
    STATE.with(|state| *state.borrow_mut() = Some(reason));
}

/// Clear the unavailable state after a successful coordinator run.
pub fn mark_agent_org_runtime_available() {
    #[cfg(not(test))]
    {
        *STATE.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }
    #[cfg(test)]
    STATE.with(|state| *state.borrow_mut() = None);
}

/// The recorded coordinator failure, if the runtime namespace is unavailable.
pub fn agent_org_runtime_unavailable_reason() -> Option<String> {
    #[cfg(not(test))]
    {
        STATE
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
    #[cfg(test)]
    STATE.with(|state| state.borrow().clone())
}

/// Fail with the structured unavailable error while the namespace is down.
pub fn ensure_agent_org_runtime_available() -> SqliteResult<()> {
    match agent_org_runtime_unavailable_reason() {
        None => Ok(()),
        Some(reason) => Err(SqliteError::SqliteFailure(
            ffi::Error::new(ffi::SQLITE_CANTOPEN),
            Some(format!("{AGENT_ORG_RUNTIME_UNAVAILABLE_PREFIX}{reason}")),
        )),
    }
}

/// Gated connection acquisition for every Agent Org store entry point.
///
/// Identical to `database::db::get_connection()` while the runtime
/// namespace is healthy; returns the structured unavailable error without
/// touching SQLite once the coordinator has reported failure.
pub(crate) fn runtime_connection() -> SqliteResult<Connection> {
    ensure_agent_org_runtime_available()?;
    database::db::get_connection()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_reports_structured_error_and_recovers() {
        assert!(agent_org_runtime_unavailable_reason().is_none());
        ensure_agent_org_runtime_available().expect("available by default");

        mark_agent_org_runtime_unavailable("boom: table missing");
        let error = runtime_connection().expect_err("gated while unavailable");
        let message = error.to_string();
        assert!(
            message.contains("agent-org runtime unavailable: boom: table missing"),
            "{message}"
        );

        mark_agent_org_runtime_available();
        assert!(agent_org_runtime_unavailable_reason().is_none());
        ensure_agent_org_runtime_available().expect("cleared");
    }
}
