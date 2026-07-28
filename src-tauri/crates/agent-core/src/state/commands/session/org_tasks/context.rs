//! Shared Agent Org session read-context resolution.
//!
//! Every Agent Org Tauri command starts by resolving the durable run context
//! and canonical member id for a session. That lookup is centralized here so
//! the command families (run view, group chat, plan approval, intervention,
//! lifecycle) share one implementation.

use rusqlite::{params, OptionalExtension};

use crate::coordination::agent_org_runs::{AgentOrgRunContext, AgentOrgRunStore};
use crate::definitions::orgs::AgentOrgsStore;
use crate::session::persistence;
use crate::state::AgentAppState;
use database::db::get_connection;

pub(super) struct SessionOrgReadContext {
    pub(super) context: Option<AgentOrgRunContext>,
    pub(super) member_id: Option<String>,
}

pub(super) async fn session_org_read_context(
    state: &AgentAppState,
    session_id: &str,
) -> Result<Option<SessionOrgReadContext>, String> {
    let runtime_context = match state.get_session(session_id).await {
        Some(session) => session
            .runtime
            .read()
            .await
            .as_ref()
            .and_then(|runtime| runtime.agent_org_context.clone()),
        None => None,
    };
    let org_store = state.app_handle.as_ref().map(|handle| {
        use tauri::Manager;
        handle
            .state::<std::sync::Arc<AgentOrgsStore>>()
            .inner()
            .clone()
    });
    let session_id = session_id.to_string();

    // This helper is shared by every Agent Org Tauri command. Session and
    // parent-walk lookups are synchronous SQLite work, so resolve the whole
    // durable identity in one blocking job instead of stalling Tokio's async
    // executor at every call site.
    tokio::task::spawn_blocking(move || -> Result<Option<SessionOrgReadContext>, String> {
        let persisted = persistence::get_session(&session_id).map_err(|err| err.to_string())?;
        let member_id = match persisted.as_ref() {
            Some(record) => Some(record.org_member_id.clone()),
            None => {
                let conn = get_connection().map_err(|err| err.to_string())?;
                conn.query_row(
                    "SELECT org_member_id FROM code_sessions WHERE session_id = ?1",
                    params![&session_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(|err| err.to_string())?
            }
        };
        if persisted.is_none() && member_id.is_none() && runtime_context.is_none() {
            return Ok(None);
        }

        let context = match runtime_context {
            Some(context) => Some(context),
            None => match org_store {
                Some(store) => AgentOrgRunStore::context_for_session_with_parent_walk(
                    &session_id,
                    store.as_ref(),
                )?,
                None => None,
            },
        };
        Ok(Some(SessionOrgReadContext {
            context,
            member_id: member_id.flatten(),
        }))
    })
    .await
    .map_err(|err| format!("Agent Org session context worker failed: {err}"))?
}

pub(super) fn require_session_member_id(
    read_context: &SessionOrgReadContext,
    session_id: &str,
) -> Result<String, String> {
    read_context
        .member_id
        .clone()
        .ok_or_else(|| format!("Agent Org session {session_id} has no canonical member_id"))
}
