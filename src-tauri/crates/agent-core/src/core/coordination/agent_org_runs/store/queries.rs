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
                    work_item_id,
                    project_slug,
                    routine_fire_id,
                    summary,
                    last_error,
                    created_at,
                    updated_at,
                    completed_at
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
                        work_item_id,
                        project_slug,
                        routine_fire_id,
                        summary,
                        last_error,
                        created_at,
                        updated_at,
                        completed_at
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

    /// List runs currently in `running` status, newest-updated first.
    /// SQL-side status filter avoids loading terminal runs. Callers that must
    /// inspect every running run (the watchdog) pass `usize::MAX`, which is
    /// safely clamped to SQLite's `i64` limit.
    pub fn list_running_runs(limit: usize) -> Result<Vec<AgentOrgRunRecord>, String> {
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
                        work_item_id,
                        project_slug,
                        routine_fire_id,
                        summary,
                        last_error,
                        created_at,
                        updated_at,
                        completed_at
                 FROM agent_org_runs
                 WHERE root_session_id IS NOT NULL
                   AND status = ?1
                 ORDER BY updated_at DESC
                 LIMIT ?2",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(
                params![
                    AgentOrgRunStatus::Running.as_str(),
                    i64::try_from(limit).unwrap_or(i64::MAX)
                ],
                row_to_run,
            )
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
