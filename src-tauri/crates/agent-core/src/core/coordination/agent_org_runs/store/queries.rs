use rusqlite::{params, Connection, OptionalExtension};

use database::db::get_connection;

use super::super::helpers::row_to_run;
use super::super::{AgentOrgRunRecord, AgentOrgRunStatus};
use super::AgentOrgRunStore;

impl AgentOrgRunStore {
    /// Load Agent Org run metadata only for roots in the current page.
    ///
    /// Results are newest-first so callers can deterministically choose the
    /// first record if legacy data contains several runs for one root.
    pub fn list_runs_for_root_session_ids(
        root_session_ids: &[String],
    ) -> Result<Vec<AgentOrgRunRecord>, String> {
        if root_session_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = get_connection().map_err(|err| err.to_string())?;
        let placeholders = (1..=root_session_ids.len())
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT id,
                    org_id,
                    coordinator_agent_id,
                    root_session_id,
                    org_snapshot_json,
                    entry_mode,
                    status,
                    activation_generation,
                    has_initial_work,
                    work_item_id,
                    project_slug,
                    routine_fire_id,
                    summary,
                    last_error,
                    failure_json,
                    last_activity_outcome,
                    created_at,
                    updated_at,
                    idled_at
             FROM agent_org_runs
             WHERE root_session_id IN ({placeholders})
             ORDER BY updated_at DESC, id DESC"
        );
        let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(
                rusqlite::params_from_iter(root_session_ids.iter()),
                row_to_run,
            )
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())
    }

    /// List every persisted run that has anchored a coordinator session,
    /// across all orgs, ordered by `updated_at DESC`. Used by the Inbox
    /// page to render its flat list of chats — each row is one run.
    ///
    /// Runs whose `root_session_id` is still `NULL` (created but the
    /// coordinator session row has not landed yet) are excluded; the
    /// Inbox renders those as transient client-side draft rows until the
    /// anchor exists.
    pub fn list_runs(limit: usize) -> Result<Vec<AgentOrgRunRecord>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id,
                        org_id,
                        coordinator_agent_id,
                        root_session_id,
                        org_snapshot_json,
                        entry_mode,
                        status,
                        activation_generation,
                        has_initial_work,
                        work_item_id,
                        project_slug,
                        routine_fire_id,
                        summary,
                        last_error,
                        failure_json,
                        last_activity_outcome,
                        created_at,
                        updated_at,
                        idled_at
                 FROM agent_org_runs
                 WHERE root_session_id IS NOT NULL
                 ORDER BY updated_at DESC
                 LIMIT ?1",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![limit as i64], row_to_run)
            .map_err(|err| err.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|err| err.to_string())?);
        }
        Ok(out)
    }

    /// List runs currently in `running` status, oldest-updated first. Periodic
    /// callers must pass their explicit bounded batch size.
    pub fn list_running_runs(limit: usize) -> Result<Vec<AgentOrgRunRecord>, String> {
        Self::list_runs_by_status(AgentOrgRunStatus::Running, limit)
    }

    pub(super) fn list_runs_by_status(
        status: AgentOrgRunStatus,
        limit: usize,
    ) -> Result<Vec<AgentOrgRunRecord>, String> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let bounded_limit = i64::try_from(limit)
            .map_err(|_| format!("Agent Org run list limit is too large: {limit}"))?;
        let conn = get_connection().map_err(|err| err.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id,
                        org_id,
                        coordinator_agent_id,
                        root_session_id,
                        org_snapshot_json,
                        entry_mode,
                        status,
                        activation_generation,
                        has_initial_work,
                        work_item_id,
                        project_slug,
                        routine_fire_id,
                        summary,
                        last_error,
                        failure_json,
                        last_activity_outcome,
                        created_at,
                        updated_at,
                        idled_at
                 FROM agent_org_runs
                 WHERE root_session_id IS NOT NULL
                   AND status = ?1
                 ORDER BY updated_at ASC, id ASC
                 LIMIT ?2",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![status.as_str(), bounded_limit], row_to_run)
            .map_err(|err| err.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|err| err.to_string())?);
        }
        Ok(out)
    }

    /// Return the current status of the run without fetching the full record.
    pub fn get_run_status(run_id: &str) -> Result<Option<AgentOrgRunStatus>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        Self::get_run_status_with_connection(&conn, run_id)
    }

    pub(crate) fn get_run_status_with_connection(
        conn: &Connection,
        run_id: &str,
    ) -> Result<Option<AgentOrgRunStatus>, String> {
        let status_raw: Option<String> = conn
            .query_row(
                "SELECT status FROM agent_org_runs WHERE id = ?1 LIMIT 1",
                params![run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| err.to_string())?;
        Ok(status_raw.as_deref().and_then(AgentOrgRunStatus::parse))
    }
}
