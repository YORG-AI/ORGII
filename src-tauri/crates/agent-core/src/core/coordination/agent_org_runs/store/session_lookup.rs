use rusqlite::{params, OptionalExtension};

use crate::definitions::orgs::AgentOrgsStore;
use database::db::get_connection;

use super::super::helpers::{
    context_for_run_record, load_by_id, load_by_root_session, parent_session_id_of,
};
use super::super::{AgentOrgRunContext, AgentOrgRunRecord};
use super::AgentOrgRunStore;

impl AgentOrgRunStore {
    /// Resolve the org-run context for an arbitrary session — works for
    /// both the root (coordinator) session and materialized member sessions
    /// linked to the same Agent Org run.
    ///
    /// Strategy: try the direct `root_session_id` lookup first; if that
    /// misses, walk the persisted `agent_sessions.parent_session_id`
    /// chain upward (using the existing `idx_agent_sessions_parent`
    /// index) and retry the lookup at each ancestor. The first ancestor
    /// that anchors an `agent_org_runs` row wins.
    ///
    /// The persisted parent chain serves as the reverse-resolution
    /// path. `root_session_id` remains the **single anchor** for an org
    /// run — no per-subagent rows are added (avoids a second source of
    /// truth and the corresponding unify-then-reshuffle reshape).
    ///
    /// Bounded to `MAX_PARENT_WALK_DEPTH` hops so a corrupt or cyclic
    /// parent chain can't cause an unbounded scan during session init.
    pub fn context_for_run(
        run_id: &str,
        org_store: &AgentOrgsStore,
    ) -> Result<Option<AgentOrgRunContext>, String> {
        let Some(run) = load_by_id(run_id).map_err(|err| err.to_string())? else {
            return Ok(None);
        };
        Ok(Some(context_for_run_record(&run, org_store)?))
    }

    pub fn context_for_session_with_parent_walk(
        session_id: &str,
        org_store: &AgentOrgsStore,
    ) -> Result<Option<AgentOrgRunContext>, String> {
        let Some(run) = Self::run_for_session_with_parent_walk(session_id)? else {
            return Ok(None);
        };
        Ok(Some(context_for_run_record(&run, org_store)?))
    }

    pub fn root_session_id_for_session_with_parent_walk(
        session_id: &str,
    ) -> Result<Option<String>, String> {
        Ok(Self::run_for_session_with_parent_walk(session_id)?.and_then(|run| run.root_session_id))
    }

    pub fn run_id_for_session_with_parent_walk(session_id: &str) -> Result<Option<String>, String> {
        Ok(Self::run_for_session_with_parent_walk(session_id)?.map(|run| run.id))
    }

    pub fn is_root_session(org_run_id: &str, session_id: &str) -> Result<bool, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let root_session_id: Option<String> = conn
            .query_row(
                "SELECT root_session_id FROM agent_org_runs WHERE id = ?1",
                params![org_run_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|err| err.to_string())?
            .flatten();
        Ok(root_session_id.as_deref() == Some(session_id))
    }

    fn run_for_session_with_parent_walk(
        session_id: &str,
    ) -> Result<Option<AgentOrgRunRecord>, String> {
        const MAX_PARENT_WALK_DEPTH: usize = 16;

        let mut current_id = session_id.to_string();
        let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
        for hop in 0..=MAX_PARENT_WALK_DEPTH {
            if !visited.insert(current_id.clone()) {
                tracing::warn!(
                    session_id = %session_id,
                    cycle_at = %current_id,
                    "[agent_org_runs] parent_session_id chain has a cycle; aborting walk"
                );
                return Ok(None);
            }
            if let Some(run) = load_by_root_session(&current_id).map_err(|err| err.to_string())? {
                return Ok(Some(run));
            }
            if hop == MAX_PARENT_WALK_DEPTH {
                tracing::warn!(
                    session_id = %session_id,
                    last_visited = %current_id,
                    "[agent_org_runs] parent_session_id walk exceeded max depth ({}); giving up",
                    MAX_PARENT_WALK_DEPTH
                );
                return Ok(None);
            }
            match parent_session_id_of(&current_id).map_err(|err| err.to_string())? {
                Some(parent) => current_id = parent,
                None => return Ok(None),
            }
        }
        Ok(None)
    }
}
