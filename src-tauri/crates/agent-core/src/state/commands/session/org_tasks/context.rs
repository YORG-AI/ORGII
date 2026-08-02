//! Shared Agent Org session read-context resolution.
//!
//! Every Agent Org Tauri command starts by resolving the durable run context
//! and canonical member id for a session. That lookup is centralized here so
//! the command families (run view, group chat, plan approval, intervention,
//! lifecycle) share one implementation.

use crate::coordination::agent_org_runs::{AgentOrgRunContext, AgentOrgRunStore};
use crate::definitions::orgs::AgentOrgsStore;
use crate::session::persistence;
use crate::state::AgentAppState;

pub(super) struct SessionOrgReadContext {
    pub(super) context: Option<AgentOrgRunContext>,
    pub(super) member_id: Option<String>,
}

pub(super) async fn session_org_read_context(
    state: &AgentAppState,
    session_id: &str,
) -> Result<Option<SessionOrgReadContext>, String> {
    session_org_read_context_inner(state, session_id, false).await
}

pub(super) async fn session_org_read_context_for_run_view(
    state: &AgentAppState,
    session_id: &str,
) -> Result<Option<SessionOrgReadContext>, String> {
    session_org_read_context_inner(state, session_id, true).await
}

async fn session_org_read_context_inner(
    state: &AgentAppState,
    session_id: &str,
    read_only: bool,
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
        let mapped_member_id = AgentOrgRunStore::member_id_for_mapped_session(&session_id)?;
        let member_id = mapped_member_id.or_else(|| {
            persisted
                .as_ref()
                .and_then(|record| record.org_member_id.clone())
        });
        if persisted.is_none() && member_id.is_none() {
            return Ok(None);
        }

        let context = match (org_store, read_only) {
            (Some(store), true) => {
                AgentOrgRunStore::context_for_session_read_only_with_parent_walk(
                    &session_id,
                    store.as_ref(),
                )?
            }
            (Some(store), false) => {
                AgentOrgRunStore::context_for_session_with_parent_walk(&session_id, store.as_ref())?
            }
            (None, _) => runtime_context,
        };
        Ok(Some(SessionOrgReadContext { context, member_id }))
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
