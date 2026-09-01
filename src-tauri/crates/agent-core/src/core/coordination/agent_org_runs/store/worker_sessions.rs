use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};

use crate::coordination::agent_member_interventions::AgentMemberInterventionStore;
use database::db::get_connection;

use super::super::helpers::flatten_members;
use super::super::worker::{WorkerSessionInfo, WorkerSessionRuntime};
use super::super::COORDINATOR_MEMBER_ID;
use super::AgentOrgRunStore;

impl AgentOrgRunStore {
    /// Find the freshest materialized worker session for a canonical roster
    /// `member_id` inside `org_run_id`.
    pub fn find_worker_session_by_member_id(
        org_run_id: &str,
        member_id: &str,
    ) -> Result<Option<WorkerSessionInfo>, String> {
        let mut sessions =
            Self::list_worker_sessions_by_member_ids(org_run_id, &[member_id.to_string()])?;
        Ok(sessions.pop().map(|session| WorkerSessionInfo {
            session_id: session.session_id,
            status: session.status,
            updated_at: session.updated_at,
        }))
    }

    pub fn find_coordinator_session_by_member_id(
        org_run_id: &str,
        member_id: &str,
    ) -> Result<Option<WorkerSessionInfo>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        Self::find_coordinator_session_by_member_id_with_connection(&conn, org_run_id, member_id)
    }

    pub(crate) fn find_coordinator_session_by_member_id_with_connection(
        conn: &Connection,
        org_run_id: &str,
        member_id: &str,
    ) -> Result<Option<WorkerSessionInfo>, String> {
        if member_id != COORDINATOR_MEMBER_ID {
            return Ok(None);
        }
        let row: Option<(String, String, String)> = conn
            .query_row(
                "SELECT s.session_id,
                        s.status,
                        s.updated_at
                 FROM agent_org_runs r
                 JOIN agent_sessions s ON s.session_id = r.root_session_id
                 WHERE r.id = ?1
                 LIMIT 1",
                params![org_run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|err| err.to_string())?;

        let Some((session_id, status_raw, updated_at)) = row else {
            return Ok(None);
        };
        let status = crate::core::session::SessionStatus::parse(&status_raw).ok_or_else(|| {
            format!("unknown coordinator session status for {session_id}: {status_raw:?}")
        })?;
        Ok(Some(WorkerSessionInfo {
            session_id,
            status,
            updated_at,
        }))
    }

    /// Return the freshest descendant session for each requested roster
    /// `member_id`. UI read models use this instead of `agent_definition_id`
    /// because multiple roster members may run the same AgentDefinition.
    pub fn list_worker_sessions_by_member_ids(
        org_run_id: &str,
        member_ids: &[String],
    ) -> Result<Vec<WorkerSessionRuntime>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        Self::list_worker_sessions_by_member_ids_with_connection(&conn, org_run_id, member_ids)
    }

    pub(crate) fn list_worker_sessions_by_member_ids_with_connection(
        conn: &Connection,
        org_run_id: &str,
        member_ids: &[String],
    ) -> Result<Vec<WorkerSessionRuntime>, String> {
        let requested: HashSet<&str> = member_ids
            .iter()
            .map(String::as_str)
            .filter(|member_id| !member_id.is_empty())
            .collect();
        if requested.is_empty() {
            return Ok(Vec::new());
        }

        let sessions = Self::list_descendant_worker_sessions_with_connection(conn, org_run_id)?;
        let mut seen = HashSet::new();
        Ok(sessions
            .into_iter()
            .filter(|session| {
                session
                    .member_id
                    .as_deref()
                    .is_some_and(|member_id| requested.contains(member_id))
            })
            .filter(|session| seen.insert(session.member_id.clone()))
            .collect())
    }

    /// Canonical member ids captured in the immutable launch snapshot.
    ///
    /// Recovery must not consult the user's current Agent Org definition: a
    /// team can be edited while an older run is still alive. `None` is kept
    /// for historical rows that predate launch snapshots; callers may still
    /// classify a materialized session, but must not invent roster membership.
    pub(crate) fn snapshot_member_ids_with_connection(
        conn: &Connection,
        org_run_id: &str,
    ) -> Result<Option<HashSet<String>>, String> {
        let snapshot_json: Option<String> = conn
            .query_row(
                "SELECT org_snapshot_json FROM agent_org_runs WHERE id=?1",
                params![org_run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| err.to_string())?
            .flatten();
        let Some(snapshot_json) = snapshot_json else {
            return Ok(None);
        };
        let snapshot: crate::definitions::orgs::OrgDefinition =
            serde_json::from_str(&snapshot_json).map_err(|err| {
                format!("failed to parse Agent Org launch snapshot for run {org_run_id}: {err}")
            })?;
        Ok(Some(
            flatten_members(&snapshot.children, None)
                .into_iter()
                .map(|member| member.member_id)
                .collect(),
        ))
    }

    pub fn list_descendant_worker_sessions(
        org_run_id: &str,
    ) -> Result<Vec<WorkerSessionRuntime>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        Self::list_descendant_worker_sessions_with_connection(&conn, org_run_id)
    }

    pub(crate) fn list_descendant_worker_sessions_with_connection(
        conn: &Connection,
        org_run_id: &str,
    ) -> Result<Vec<WorkerSessionRuntime>, String> {
        let root_session_id: Option<String> = conn
            .query_row(
                "SELECT root_session_id FROM agent_org_runs WHERE id = ?1",
                params![org_run_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|err| err.to_string())?
            .flatten();
        let Some(root) = root_session_id else {
            return Ok(Vec::new());
        };
        let interventions =
            AgentMemberInterventionStore::list_active_with_connection(conn, org_run_id)?
                .into_iter()
                .map(|record| (record.member_id.clone(), record))
                .collect::<HashMap<_, _>>();

        let mut stmt = conn
            .prepare(
                "WITH RECURSIVE descendants(session_id) AS (
                     SELECT session_id
                     FROM agent_sessions child
                     WHERE child.parent_session_id = ?1
                       AND NOT EXISTS (
                           SELECT 1 FROM agent_org_runs nested
                           WHERE nested.id <> ?2
                             AND nested.root_session_id = child.session_id
                       )
                     UNION
                     SELECT s.session_id
                     FROM agent_sessions s
                     JOIN descendants d ON s.parent_session_id = d.session_id
                     WHERE NOT EXISTS (
                         SELECT 1 FROM agent_org_runs nested
                         WHERE nested.id <> ?2
                           AND nested.root_session_id = s.session_id
                     )
                 ), ranked AS (
                     SELECT s.agent_definition_id,
                            s.org_member_id,
                            s.session_id,
                            s.status,
                            s.updated_at,
                            ROW_NUMBER() OVER (
                                PARTITION BY CASE
                                    WHEN s.org_member_id IS NOT NULL
                                        THEN 'member:' || s.org_member_id
                                    ELSE 'session:' || s.session_id
                                END
                                ORDER BY s.updated_at DESC, s.session_id DESC
                            ) AS rank
                     FROM agent_sessions s
                     JOIN descendants d USING (session_id)
                     WHERE s.agent_definition_id IS NOT NULL
                 )
                 SELECT agent_definition_id, org_member_id, session_id, status, updated_at
                 FROM ranked
                 WHERE rank = 1
                 ORDER BY updated_at DESC, session_id DESC",
            )
            .map_err(|err| err.to_string())?;

        let rows = stmt
            .query_map(params![root.clone(), org_run_id], |row| {
                let status_raw: String = row.get(3)?;
                let status =
                    crate::core::session::SessionStatus::parse(&status_raw).ok_or_else(|| {
                        rusqlite::Error::FromSqlConversionFailure(
                            3,
                            rusqlite::types::Type::Text,
                            format!("unknown SessionStatus value: {status_raw:?}").into(),
                        )
                    })?;
                let agent_definition_id: String = row.get(0)?;
                let org_member_id: Option<String> = row.get(1)?;
                let intervention = org_member_id
                    .as_deref()
                    .and_then(|member_id| interventions.get(member_id).cloned());
                Ok(WorkerSessionRuntime {
                    intervention,
                    agent_definition_id: Some(agent_definition_id),
                    cli_agent_type: None,
                    member_id: org_member_id,
                    session_id: row.get(2)?,
                    parent_session_id: Some(root.clone()),
                    status,
                    updated_at: row.get(4)?,
                })
            })
            .map_err(|err| err.to_string())?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|err| err.to_string())?);
        }

        let mut cli_stmt = conn
            .prepare(
                "SELECT cli_agent_type, org_member_id, session_id, status, updated_at
                 FROM code_sessions
                 WHERE parent_session_id = ?1
                   AND org_member_id IS NOT NULL
                   AND cli_agent_type IS NOT NULL
                 ORDER BY updated_at DESC, session_id DESC",
            )
            .map_err(|err| err.to_string())?;
        let cli_rows = cli_stmt
            .query_map(params![root.clone()], |row| {
                let status_raw: String = row.get(3)?;
                let status =
                    crate::core::session::SessionStatus::parse(&status_raw).ok_or_else(|| {
                        rusqlite::Error::FromSqlConversionFailure(
                            3,
                            rusqlite::types::Type::Text,
                            format!("unknown CLI SessionStatus value: {status_raw:?}").into(),
                        )
                    })?;
                let cli_agent_type: String = row.get(0)?;
                let org_member_id: Option<String> = row.get(1)?;
                let intervention = org_member_id
                    .as_deref()
                    .and_then(|member_id| interventions.get(member_id).cloned());
                Ok(WorkerSessionRuntime {
                    intervention,
                    agent_definition_id: None,
                    cli_agent_type: Some(cli_agent_type),
                    member_id: org_member_id,
                    session_id: row.get(2)?,
                    parent_session_id: Some(root.clone()),
                    status,
                    updated_at: row.get(4)?,
                })
            })
            .map_err(|err| err.to_string())?;
        for row in cli_rows {
            out.push(row.map_err(|err| err.to_string())?);
        }

        out.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                // Historical databases can contain both a Rust and a CLI
                // session for one member at the same timestamp. Rust is the
                // only supported Agent Org transport, so it wins an exact tie.
                .then_with(|| {
                    left.cli_agent_type
                        .is_some()
                        .cmp(&right.cli_agent_type.is_some())
                })
                .then_with(|| right.session_id.cmp(&left.session_id))
        });

        // Rust and CLI sessions live in different tables, so neither table's
        // window function can suppress an older duplicate from the other
        // transport.  Apply the canonical-member rule once more after the
        // combined freshness sort.  Historical rows without a member id are
        // distinct sessions; do not guess that they belong to one member.
        let mut seen_canonical_workers = HashSet::new();
        out.retain(|session| {
            let key = session
                .member_id
                .as_ref()
                .map(|member_id| format!("member:{member_id}"))
                .unwrap_or_else(|| format!("session:{}", session.session_id));
            seen_canonical_workers.insert(key)
        });
        Ok(out)
    }
}
