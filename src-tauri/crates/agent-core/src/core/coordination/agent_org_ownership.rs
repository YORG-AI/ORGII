//! Canonical ownership resolution for one long-lived Agent Org Team.
//!
//! Archive, Team Delete, and the generic Session Delete guard all use this
//! resolver. A member Session must never fall through to ordinary one-row
//! deletion merely because only the root row carries `root_session_id`.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};

use super::agent_org_runs::AgentOrgRunStatus;
use crate::core::session::SessionStatus;

pub const MAX_AGENT_ORG_OWNED_SESSIONS: usize = 1_024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentOrgOwnedSession {
    pub session_id: String,
    pub parent_session_id: Option<String>,
    pub member_id: Option<String>,
    pub status: SessionStatus,
    pub depth: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentOrgTeamOwnership {
    pub run_id: String,
    pub root_session_id: String,
    pub run_status: AgentOrgRunStatus,
    pub activation_generation: i64,
    pub archived_at: Option<String>,
    pub archive_receipt_id: Option<String>,
    pub sessions: Vec<AgentOrgOwnedSession>,
}

struct AgentOrgRunOwnershipRow {
    root_session_id: String,
    status: String,
    activation_generation: i64,
    archived_at: Option<String>,
    archive_receipt_id: Option<String>,
}

/// Resolve either a Team root or any descendant member to its single Team.
/// Corrupt cycles, duplicate root claims, and nested Team roots fail closed.
pub fn resolve_team_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<AgentOrgTeamOwnership>, String> {
    let mut current_id = session_id.to_string();
    let mut visited = HashSet::new();
    let mut candidate_run_id = None;
    let mut saw_agent_org_member_marker = false;

    for _ in 0..=MAX_AGENT_ORG_OWNED_SESSIONS {
        if !visited.insert(current_id.clone()) {
            return Err(format!(
                "agent_org_ownership_ambiguous: ancestry cycle at session {current_id}"
            ));
        }
        let run_ids = run_ids_for_root(conn, &current_id)?;
        if run_ids.len() > 1 {
            return Err(format!(
                "agent_org_ownership_ambiguous: {} runs claim root session {current_id}",
                run_ids.len()
            ));
        }
        if let Some(run_id) = run_ids.into_iter().next() {
            if candidate_run_id.replace(run_id).is_some() {
                return Err(format!(
                    "agent_org_ownership_ambiguous: session {session_id} is nested beneath multiple Team roots"
                ));
            }
        }

        let row: Option<(Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT parent_session_id,org_member_id
                 FROM agent_sessions WHERE session_id=?1",
                [&current_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some((parent, member_id)) = row else {
            break;
        };
        saw_agent_org_member_marker |= member_id.is_some();
        match parent {
            Some(parent) => current_id = parent,
            None => break,
        }
    }

    let Some(run_id) = candidate_run_id else {
        if saw_agent_org_member_marker
            || descendant_agent_org_member_marker_exists(conn, session_id)?
        {
            return Err(format!(
                "agent_org_ownership_ambiguous: session {session_id} or its descendants have an Agent Org member marker but no owning Team root"
            ));
        }
        return Ok(None);
    };
    load_team_for_run(conn, &run_id).map(Some)
}

fn descendant_agent_org_member_marker_exists(
    conn: &Connection,
    session_id: &str,
) -> Result<bool, String> {
    conn.query_row(
        "WITH RECURSIVE descendants(session_id,depth,path,cycle) AS (
             SELECT session_id,0,'/' || hex(session_id) || '/',0
             FROM agent_sessions WHERE session_id=?1
             UNION ALL
             SELECT child.session_id,parent.depth + 1,
                    parent.path || hex(child.session_id) || '/',
                    instr(parent.path, '/' || hex(child.session_id) || '/') > 0
             FROM agent_sessions child
             JOIN descendants parent ON child.parent_session_id=parent.session_id
             WHERE parent.cycle=0 AND parent.depth < ?2
         )
         SELECT EXISTS(
             SELECT 1 FROM descendants descendant
             JOIN agent_sessions session ON session.session_id=descendant.session_id
             WHERE descendant.depth>0 AND session.org_member_id IS NOT NULL
         )",
        params![session_id, MAX_AGENT_ORG_OWNED_SESSIONS as i64],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

pub fn load_team_for_run(conn: &Connection, run_id: &str) -> Result<AgentOrgTeamOwnership, String> {
    let run: Option<AgentOrgRunOwnershipRow> = conn
        .query_row(
            "SELECT root_session_id,status,activation_generation,archived_at,archive_receipt_id
             FROM agent_org_runtime_runs WHERE id=?1",
            [run_id],
            |row| {
                Ok(AgentOrgRunOwnershipRow {
                    root_session_id: row.get(0)?,
                    status: row.get(1)?,
                    activation_generation: row.get(2)?,
                    archived_at: row.get(3)?,
                    archive_receipt_id: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(run) = run else {
        return Err(format!("agent_org_run_not_found: {run_id}"));
    };
    let run_status = AgentOrgRunStatus::parse(&run.status).ok_or_else(|| {
        format!(
            "agent_org_ownership_ambiguous: unknown run status {:?}",
            run.status
        )
    })?;
    let sessions = load_owned_sessions(conn, run_id, &run.root_session_id)?;
    Ok(AgentOrgTeamOwnership {
        run_id: run_id.to_string(),
        root_session_id: run.root_session_id,
        run_status,
        activation_generation: run.activation_generation,
        archived_at: run.archived_at,
        archive_receipt_id: run.archive_receipt_id,
        sessions,
    })
}

fn run_ids_for_root(conn: &Connection, root_session_id: &str) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id FROM agent_org_runtime_runs
             WHERE root_session_id=?1 ORDER BY id",
        )
        .map_err(|error| error.to_string())?;
    let run_ids = statement
        .query_map([root_session_id], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(run_ids)
}

fn load_owned_sessions(
    conn: &Connection,
    run_id: &str,
    root_session_id: &str,
) -> Result<Vec<AgentOrgOwnedSession>, String> {
    let mut statement = conn
        .prepare(
            "WITH RECURSIVE descendants(
                 session_id,parent_session_id,org_member_id,status,depth,path,cycle
             ) AS (
                 SELECT session_id,parent_session_id,org_member_id,status,0,
                        '/' || hex(session_id) || '/',0
                 FROM agent_sessions WHERE session_id=?1
                 UNION ALL
                 SELECT child.session_id,child.parent_session_id,child.org_member_id,
                        child.status,parent.depth + 1,
                        parent.path || hex(child.session_id) || '/',
                        instr(parent.path, '/' || hex(child.session_id) || '/') > 0
                 FROM agent_sessions child
                 JOIN descendants parent ON child.parent_session_id=parent.session_id
                 WHERE parent.cycle=0 AND parent.depth < ?3
             )
             SELECT descendant.session_id,descendant.parent_session_id,
                    descendant.org_member_id,descendant.status,descendant.depth,
                    descendant.cycle,
                    (SELECT nested.id FROM agent_org_runtime_runs nested
                     WHERE nested.id<>?2
                       AND nested.root_session_id=descendant.session_id
                     ORDER BY nested.id LIMIT 1),
                    EXISTS(SELECT 1 FROM agent_sessions child
                           WHERE child.parent_session_id=descendant.session_id)
             FROM descendants descendant",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(
            params![root_session_id, run_id, MAX_AGENT_ORG_OWNED_SESSIONS as i64],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, bool>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, bool>(7)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?;

    let mut sessions = Vec::new();
    let mut visited = HashSet::new();
    for row in rows {
        let (
            session_id,
            parent_session_id,
            member_id,
            status_raw,
            depth,
            cycle,
            nested_run,
            has_children,
        ) = row.map_err(|error| error.to_string())?;
        if cycle || !visited.insert(session_id.clone()) {
            return Err(format!(
                "agent_org_ownership_ambiguous: Team {run_id} session hierarchy cycles at {session_id}"
            ));
        }
        let depth = usize::try_from(depth).map_err(|error| error.to_string())?;
        if depth >= MAX_AGENT_ORG_OWNED_SESSIONS && has_children {
            return Err(format!(
                "agent_org_ownership_ambiguous: Team {run_id} exceeds {MAX_AGENT_ORG_OWNED_SESSIONS} owned Sessions"
            ));
        }
        if depth > 0 {
            if let Some(nested_run_id) = nested_run {
                return Err(format!(
                    "agent_org_ownership_ambiguous: descendant {session_id} is root of nested Team {nested_run_id}"
                ));
            }
        }
        let status = SessionStatus::parse(&status_raw).ok_or_else(|| {
            format!(
                "agent_org_ownership_ambiguous: session {session_id} has unknown status {status_raw:?}"
            )
        })?;
        sessions.push(AgentOrgOwnedSession {
            session_id,
            parent_session_id,
            member_id,
            status,
            depth,
        });
        if sessions.len() > MAX_AGENT_ORG_OWNED_SESSIONS {
            return Err(format!(
                "agent_org_ownership_ambiguous: Team {run_id} exceeds {MAX_AGENT_ORG_OWNED_SESSIONS} owned Sessions"
            ));
        }
    }
    if sessions.is_empty()
        || !sessions
            .iter()
            .any(|session| session.depth == 0 && session.session_id == root_session_id)
    {
        return Err(format!(
            "agent_org_ownership_ambiguous: Team {run_id} root session {root_session_id} is missing"
        ));
    }

    let depths = sessions
        .iter()
        .map(|session| (session.session_id.as_str(), session.depth))
        .collect::<HashMap<_, _>>();
    for session in &sessions {
        if session.depth == 0 {
            continue;
        }
        let parent = session.parent_session_id.as_deref().ok_or_else(|| {
            format!(
                "agent_org_ownership_ambiguous: descendant {} has no parent",
                session.session_id
            )
        })?;
        let parent_depth = depths.get(parent).ok_or_else(|| {
            format!(
                "agent_org_ownership_ambiguous: descendant {} references missing parent {parent}",
                session.session_id
            )
        })?;
        if parent_depth.saturating_add(1) != session.depth {
            return Err(format!(
                "agent_org_ownership_ambiguous: descendant {} has inconsistent depth",
                session.session_id
            ));
        }
    }
    sessions.sort_by(|left, right| {
        right
            .depth
            .cmp(&left.depth)
            .then_with(|| left.session_id.cmp(&right.session_id))
    });
    Ok(sessions)
}
