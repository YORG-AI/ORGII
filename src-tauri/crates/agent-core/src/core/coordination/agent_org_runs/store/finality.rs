use rusqlite::{params, Connection};

use database::db::{get_connection, with_sessions_writer};

use super::super::finality::load_and_assess;
use super::super::{AgentOrgFinalityAssessment, AgentOrgFinalityDecision, AgentOrgRunStatus};
use super::AgentOrgRunStore;

impl AgentOrgRunStore {
    pub fn assess_run_finality(run_id: &str) -> Result<AgentOrgFinalityAssessment, String> {
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Deferred)
            .map_err(|err| err.to_string())?;
        let assessment = load_and_assess(&tx, run_id)?;
        tx.commit().map_err(|err| err.to_string())?;
        Ok(assessment)
    }

    pub fn reconcile_run_finality(run_id: &str) -> Result<Option<AgentOrgRunStatus>, String> {
        // Finality and every task mutation share the sessions writer lock. The
        // canonical typed facts are re-read inside this IMMEDIATE transaction;
        // no analyzer snapshot is trusted across the lock boundary.
        let (status, changed) =
            with_sessions_writer(|| -> Result<(Option<AgentOrgRunStatus>, bool), String> {
                let mut conn = get_connection().map_err(|err| err.to_string())?;
                let tx = conn
                    .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                    .map_err(|err| err.to_string())?;
                let assessment = load_and_assess(&tx, run_id)?;
                let Some(current_status) = assessment.facts.run_status else {
                    tx.commit().map_err(|err| err.to_string())?;
                    return Ok((None, false));
                };
                let next_status = match assessment.decision {
                    AgentOrgFinalityDecision::Complete => AgentOrgRunStatus::Completed,
                    AgentOrgFinalityDecision::Abandon => AgentOrgRunStatus::Abandoned,
                    AgentOrgFinalityDecision::KeepRunning => {
                        tx.commit().map_err(|err| err.to_string())?;
                        return Ok((Some(current_status), false));
                    }
                };
                let now = chrono::Utc::now().to_rfc3339();
                let completion_summary = assessment
                    .facts
                    .progress
                    .as_ref()
                    .and_then(|progress| progress.completion_summary.as_deref());
                let changed = tx
                    .execute(
                        "UPDATE agent_org_runs
                     SET status=?1,
                         summary=COALESCE(?2, summary),
                         updated_at=?3,
                         completed_at=?3
                     WHERE id=?4 AND status=?5",
                        params![
                            next_status.as_str(),
                            completion_summary,
                            &now,
                            run_id,
                            AgentOrgRunStatus::Running.as_str(),
                        ],
                    )
                    .map_err(|err| err.to_string())?;
                if changed != 1 {
                    tx.commit().map_err(|err| err.to_string())?;
                    return Ok((Self::get_run_status(run_id)?, false));
                }
                // Terminal status and cancellation of an otherwise stranded plan
                // approval are one atomic state transition.
                tx.execute(
                    "UPDATE agent_org_plan_approvals
                 SET status='cancelled', decision_by='system', resolved_at=?2
                 WHERE org_run_id=?1 AND status='pending'",
                    params![run_id, &now],
                )
                .map_err(|err| err.to_string())?;
                tx.commit().map_err(|err| err.to_string())?;
                Ok((Some(next_status), true))
            })?;
        if changed {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(run_id);
        }
        Ok(status)
    }

    /// Read the canonical finality facts and decision from an existing
    /// connection or read transaction. Run View and task-list projections use
    /// this to keep all of their independently-shaped rows on one SQLite
    /// snapshot instead of opening a fresh connection for each block.
    pub(crate) fn finality_assessment_with_connection(
        conn: &Connection,
        run_id: &str,
    ) -> Result<AgentOrgFinalityAssessment, String> {
        load_and_assess(conn, run_id)
    }
}
